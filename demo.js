/**
 * Shares or unshares a device between two Geotab databases using the modern DeviceShare API.
 *
 * @param {Object} srcApi - Source API object containing credentials and call methods for the source database
 * @param {Object} tgtApi - Target API object containing credentials and call methods for the target database
 * @param {string} deviceId - The ID of the device to share/unshare from the source database
 * @param {boolean} shareDevice - If true, shares the device from source to target; if false, terminates the share and archives the device in target
 */
async function shareDeviceModern(srcApi, tgtApi, deviceId, shareDevice) {
  const srcDatabase = srcApi.credentials.database,
    tgtDatabase = tgtApi.credentials.database,
    autoAccept = true; // whether or not we are utilizing the auto accept system setting feature

  try {
    const srcDevice = await getDeviceDetails(srcApi, deviceId);
    let tgtDevice = await getDeviceDetailsBySerial(tgtApi, srcDevice.serialNumber);

    if (!srcDevice.serialNumber || srcDevice.serialNumber === '' || !srcDevice.devicePlanBillingInfo?.[0]) {
      throw new Error('Device not shareable');
    }
  
    // console.log('*** srcDevice', srcDevice);
    
    if (shareDevice) {
      // starting a share
      // set the system setting to auto accept shares on the target database
      await setSystemSettings(tgtApi, {
        enableDataShareAutoAccept: autoAccept,
      });
      
      // creating the share
      let tgtDeviceShare, srcDeviceShare;

      // make sure the device isnt already shared to the target
      tgtDeviceShare = await getDeviceShareByFilters(tgtApi, { serialNumber: srcDevice.serialNumber, shareStatus: 'Active' });
      
      if (!tgtDeviceShare) {
        // need to look for a Pending DeviceShare in the source db
        srcDeviceShare = await getDeviceShareByFilters(srcApi, { serialNumber: srcDevice.serialNumber, shareStatus: 'Pending' });

        if (!srcDeviceShare) {
          // create the DeviceShare on the source database
          const shareId = await srcApi.call('Add', {
            typeName: 'DeviceShare',
            entity: {
              serialNumber: srcDevice.serialNumber,
              sourceDatabaseName: srcDatabase,
              targetDatabaseName: tgtDatabase,
              // supposedly the plan info is getting forwarded automatically on the backend
              // devicePlanBillingInfo: srcDevice.devicePlanBillingInfo[0],
            },
          });
  
          // console.log('**** shareId', shareId);
        
          // get the source and target DeviceShare objects, and check for the target device
          srcDeviceShare = await getDeviceShareByFilters(srcApi, { id: shareId });
        } else {
          console.log(`Pending share already found in source database: ${srcDatabase}`);
        }

        // Retry the target lookup because the share may take time to propagate.
        const {
          result: tgtDeviceShareNow,
          attempts,
          elapsedMs,
        } = await retryWithBackoff(
          () => getDeviceShareByFilters(tgtApi, { myAdminId: srcDeviceShare.myAdminId })
        );

        if (!tgtDeviceShareNow) {
          throw new Error(`Device share not found in target database: ${tgtDatabase} after ${attempts} attempts (${elapsedMs}ms)`);
        }

        tgtDeviceShare = tgtDeviceShareNow;
      } else {
        console.log(`Device already shared to: ${tgtDatabase}. Continuing on with device add/restore`);
      }

      // console.log('*** srcDeviceShare', srcDeviceShare);
      // console.log('*** tgtDeviceShare', tgtDeviceShare);

      // approve the share request on the target db
      // NOTE: this may not be required, if the target database has the system setting `enableDataShareAutoAccept` set to true
      if (tgtDeviceShare.shareStatus === 'Pending') {
        if (!autoAccept) {
          await tgtApi.call('Set', {
            typeName: 'DeviceShare',
            entity: {
              ...tgtDeviceShare,
              shareStatus: 'RequestApproved',
              // the below does not work to effectively set all the desired attrs, so it's done later on
              // device: tgtDeviceAttrs,
            },
          });
        }

        // poll srcDeviceShare until it becomes Active
        // this is required even if autoAccept is true
        const {
          result: srcDeviceShareNow,          
          attempts,
          elapsedMs,
        } = await retryWithBackoff(
          () => getDeviceShareByFilters(srcApi, { myAdminId: srcDeviceShare.myAdminId, shareStatus: 'Active' })
        );

        if (!srcDeviceShareNow) {
          throw new Error(`Source db device share did not become Active after ${attempts} attempts (${elapsedMs}ms)`);
        }
      } else {
        console.log(`Target database DeviceShare status is NOT "Pending" and is instead "${tgtDeviceShare.shareStatus}"`);
      }
      
      // update the device
      // the DeviceShare call will automatically create it, but when doing the autoAccept we have no control over the device name
      // without autoAccept we can control the device name and other settings in the RequestApproved step, but that is ignored when autoAccepting
      // and actually settings device attrs in the RequestApproved step doesn't apply all attributes, forcing us to manually update here
      const initialGroup = srcDevice.groups.find(g => 
        ['GroupVehicleId', 'GroupTrailerId', 'GroupContainerId', 'GroupEquipmentId'].includes(g.id)
      );
      const tgtDeviceAttrs = {
        name: srcDevice.name,
        serialNumber: srcDevice.serialNumber,
        licensePlate: srcDevice.licensePlate,
        licenseState: srcDevice.licenseState,
        ...(initialGroup
          ? { groups: [{ id: initialGroup.id }] }
          : {}
        ),
      };
      tgtDevice = await getDeviceDetailsBySerial(tgtApi, srcDevice.serialNumber);
      // console.log('*** tgtDevice', tgtDevice);
      await updateDevice(tgtApi, tgtDevice.id, tgtDeviceAttrs);
    } else {
      // stopping the share
      // stop the share
      const srcDeviceShares = await getDeviceSharesByFilters(srcApi, { serialNumber: srcDevice.serialNumber });

      for (const srcDeviceShare of srcDeviceShares) {
        if (srcDeviceShare.shareStatus === 'Active') {
          // console.log('*** srcDeviceShare [Active]', srcDeviceShare);

          // NOTE: Termination can be performed in either the source and target databases.
          // we'll try to do it from the tgt db hoping its more synchronous thus allowing immediate archival or the device
          const tgtDeviceShare = await getDeviceShareByFilters(tgtApi, { myAdminId: srcDeviceShare.myAdminId, shareStatus: 'Active' });

          if (tgtDeviceShare) {
            // console.log('*** tgtDeviceShare', tgtDeviceShare);

            await tgtApi.call('Set', {
              typeName: 'DeviceShare',
              entity: {
                ...tgtDeviceShare,
                shareStatus: 'RequestTerminated',
              },
            });

            // poll srcDeviceShare until it becomes Terminated
            const {
              result: srcDeviceShareNow,
              attempts,
              elapsedMs,
            } = await retryWithBackoff(
              () => getDeviceShareByFilters(srcApi, { myAdminId: srcDeviceShare.myAdminId, shareStatus: 'Terminated' })
            );

            if (!srcDeviceShareNow) {
              throw new Error(`Source db device share did not become Terminated after ${attempts} attempts (${elapsedMs}ms)`);
            }
          } else {
            await srcApi.call('Set', {
              typeName: 'DeviceShare',
              entity: {
                ...srcDeviceShare,
                shareStatus: 'RequestTerminated',
              },
            });
          }
        } else if (srcDeviceShare.shareStatus === 'Pending') {
          // console.log('*** srcDeviceShare [Pending]', srcDeviceShare);

          // NOTE: Cancellation can only be done in the source database.
          await srcApi.call('Set', {
            typeName: 'DeviceShare',
            entity: {
              ...srcDeviceShare,
              shareStatus: 'RequestCancelled',
            },
          });
        }
      }

      // archive the device
      if (tgtDevice) {
        // console.log('*** tgtDevice', tgtDevice);
        await archiveDevice(tgtApi, tgtDevice.id);
      }
    }

    return [true, {
      tgtDevice,
    }];
  } catch (ex) {
    console.error(ex);
    throw ex;
  }
}

async function retryWithBackoff(task, {
  maxAttempts = 12,
  quickAttempts = 4,
  baseDelayMs = 50,
  maxDelayMs = 2000,
} = {}) {
  const start = Date.now();
  let lastResult;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await task(attempt, Date.now() - start);
  
    if (lastResult) {
      const elapsed = Date.now() - start;
      console.log(`Task succeeded on attempt ${attempt + 1} after ${elapsed}ms`);
      return { result: lastResult, attempts: attempt + 1, elapsedMs: elapsed };
    }
  
    if (attempt === maxAttempts - 1) {
      break;
    }
  
    const delay = attempt < quickAttempts
      ? baseDelayMs
      : Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - quickAttempts + 1));
  
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  const totalElapsed = Date.now() - start;
  return { result: null, attempts: maxAttempts, elapsedMs: totalElapsed };
}

async function getDeviceSharesByFilters(api, filters={}) {
  const shares = await api.call('Get', {
    typeName: 'DeviceShare',
    search: filters,
  });
  
  return shares;
}

async function getDeviceShareByFilters(api, filters={}) {
  return (await getDeviceSharesByFilters(api, filters))[0];
}

async function updateDevice(api, deviceId, attrs={}) {
  return await api.call('Set', {
    typeName: 'Device',
    entity: {
      id: deviceId,
      ...attrs,
    },
  });
}

async function archiveDevice(api, deviceId) {
  return await updateDevice(api, deviceId, {
    activeTo: new Date().toISOString(),
  });
}

async function getDeviceDetailsBySerial(api, serialNumber) {
  const devices = await api.call('Get', {
    typeName: 'Device',
    search: {
      serialNumber,
    },
  });

  return devices[0];
}

async function getDeviceDetails(api, deviceId) {
  const devices = await api.call('Get', {
    typeName: 'Device',
    search: {
      id: deviceId,
    },
  });

  return devices[0];
}

async function getSystemSettings(api) {
  const settings = await api.call('Get', {
    typeName: 'SystemSettings',
  });

  return settings[0];
}

async function setSystemSettings(api, settings={}) {
  const { dataVersion } = await getSystemSettings(api);

  return await api.call('Set', {
    typeName: 'SystemSettings',
    entity: {
      ...settings,
      dataVersion,
    }
  });
}
