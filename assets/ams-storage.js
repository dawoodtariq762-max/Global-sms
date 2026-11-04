/*
 * GLOBAL SMS — one-time browser storage migration.
 *
 * This file is loaded before every panel/login guard. It copies values from
 * the panel's pre-GLOBAL storage keys to the GLOBAL keys and then removes the old
 * keys. Token values themselves are not changed, so an already signed-in
 * browser keeps its existing session after the rebrand deploy.
 */
(function () {
  'use strict';

  var exact = {
    client_welcome_seen: 'ams_client_welcome_seen',
    carrier_integration_lock: 'ams_carrier_integration_lock',
    qm_from: 'ams_from'
  };

  function replacementKey(key) {
    if (Object.prototype.hasOwnProperty.call(exact, key)) return exact[key];
    if (key.indexOf('ms_') === 0) return 'ams_' + key.slice(3);
    if (key.indexOf('qtech_') === 0) return 'ams_' + key.slice(6);
    if (key.indexOf('gx_') === 0) return 'ams_' + key.slice(3);
    return null;
  }

  function migrate(storage) {
    if (!storage) return;
    try {
      var keys = [];
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (key) keys.push(key);
      }
      keys.forEach(function (oldKey) {
        var newKey = replacementKey(oldKey);
        if (!newKey || newKey === oldKey) return;
        var value = storage.getItem(oldKey);
        if (value !== null && storage.getItem(newKey) === null) {
          storage.setItem(newKey, value);
        }
        storage.removeItem(oldKey);
      });
    } catch (e) {
      /* Storage can be unavailable in private/blocked contexts; the normal
       * login flow remains available and no migration is attempted again
       * until the next page load. */
    }
  }

  migrate(window.sessionStorage);
  migrate(window.localStorage);
  window.AMSStorage = Object.freeze({ migrated: true, version: 'ams-20261026-fullrebrand-final' });
})();
