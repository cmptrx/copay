'use strict';
var preconditions = require('preconditions').singleton();

var _ = require('underscore');
var log = require('../log');

var querystring = require('querystring');
var request = require('request');
var cryptoUtil = require('../util/crypto');
var version = require('../../version').version;
var TxProposals = require('./TxProposals');
var PublicKeyRing = require('./PublicKeyRing');
var PrivateKey = require('./PrivateKey');
var Wallet = require('./Wallet');
var PluginManager = require('./PluginManager');
var Profile = require('./Profile');
var Insight = module.exports.Insight = require('./Insight');
var Async = module.exports.Async = require('./Async');
var Storage = module.exports.Storage = require('./Storage');

/**
 * @desc
 * Identity - stores the state for a wallet in creation
 *
 * @param {Object} config - configuration for this wallet
 * @param {Object} config.wallet - default configuration for the wallet
 * @constructor
 */

function Identity(password, opts) {
  preconditions.checkArgument(opts);

  opts = _.extend({}, opts);
  this.request = opts.request || request;
  this.storage = Identity._getStorage(opts, password);
  this.networkOpts = {
    'livenet': opts.network.livenet,
    'testnet': opts.network.testnet,
  };
  this.blockchainOpts = {
    'livenet': opts.network.livenet,
    'testnet': opts.network.testnet,
  };

  this.pluginManager = opts.pluginManager || {};
  this.insightSaveOpts = opts.insightSave || {};
  this.walletDefaults = opts.walletDefaults || {};
  this.version = opts.version || version;

  this.wallets = {};
};


/* for stubbing */
Identity._createProfile = function(email, password, storage, cb) {
  Profile.create(email, password, storage, cb);
};

Identity._newStorage = function(opts) {
  return new Storage(opts);
};

Identity._newWallet = function(opts) {
  return new Wallet(opts);
};

Identity._walletFromObj = function(o, readOpts) {
  return Wallet.fromObj(o, readOpts);
};

Identity._walletDelete = function(id, s, cb) {
  return Wallet.delete(id, s, cb);
};

/* for stubbing */
Identity._openProfile = function(email, password, storage, cb) {
  Profile.open(email, password, storage, cb);
};

/* for stubbing */
Identity._newAsync = function(opts) {
  return new Async(opts);
};

Identity._getStorage = function(opts, password) {
  var storageOpts = {};

  if (opts.pluginManager) {
    storageOpts = _.clone({
      db: opts.pluginManager.get('DB'),
      passphraseConfig: opts.passphraseConfig,
    });
  }
  if (password)
    storageOpts.password = password;

  return Identity._newStorage(storageOpts);
};

/**
 * check if any profile exists on storage
 *
 * @param opts.storageOpts
 * @param cb
 */
Identity.anyProfile = function(opts, cb) {
  var storage = Identity._getStorage(opts);
  storage.getFirst(Profile.key(''), {
    onlyKey: true
  }, function(err, v, k) {
    return cb(k ? true : false);
  });
};

/**
 * check if any wallet exists on storage
 *
 * @param opts.storageOpts
 * @param cb
 */
Identity.anyWallet = function(opts, cb) {
  var storage = Identity._getStorage(opts);
  storage.getFirst(Wallet.getStorageKey(''), {
    onlyKey: true
  }, function(err, v, k) {
    return cb(k ? true : false);
  });
};

/**
 * creates and Identity
 *
 * @param email
 * @param password
 * @param opts
 * @param cb
 * @return {undefined}
 */
Identity.create = function(email, password, opts, cb) {
  opts = opts || {};

  var iden = new Identity(password, opts);

  Identity._createProfile(email, password, iden.storage, function(err, profile) {
    if (err) return cb(err);
    iden.profile = profile;

    if (opts.noWallets)
      cb(null, iden);

    // default wallet
    var dflt = _.clone(opts.walletDefaults);
    var wopts = _.extend(dflt, {
      nickname: email,
      networkName: opts.networkName,
      requiredCopayers: 1,
      totalCopayers: 1,
      password: password,
      name: 'general'
    });
    iden.createWallet(wopts, function(err, w) {
      if (err) {
        return cb(err);
      }
      if (iden.pluginManager.get && iden.pluginManager.get('remote-backup')) {
        iden.pluginManager.get('remote-backup').store(
          iden,
          iden.insightSaveOpts,
          function(error) {
            // FIXME: Ignoring this error may not be the best thing to do. But remote storage
            // is not required for the user to use the wallet.
            return cb(null, iden, w);
          }
        );
      } else {
        return cb(null, iden, w);
      }
    });
  });
};

/**
 * validates Profile's email
 *
 * @param authcode
 * @param cb
 * @return {undefined}
 */
Identity.prototype.validate = function(authcode, cb) {
  // TODO
  console.log('[Identity.js.99] TODO: Should validate email thru authcode'); //TODO
  return cb();
};


/**
 * open's an Identity from storage
 *
 * @param email
 * @param password
 * @param opts
 * @param cb
 * @return {undefined}
 */
Identity.open = function(email, password, opts, cb) {
  var iden = new Identity(password, opts);

  Identity._openProfile(email, password, iden.storage, function(err, profile) {
    if (err) {
      if (err.message && err.message.indexOf('PNOTFOUND') !== -1) {
        if (opts.pluginManager && opts.pluginManager.get('remote-backup')) {
          return opts.pluginManager.get('remote-backup').retrieve(email, password, opts, cb);
        } else {
          return cb(err);
        }
      }
      return cb(err);
    }
    iden.profile = profile;

    var wids = _.pluck(iden.listWallets(), 'id');
    if (!wids || !wids.length)
      return cb(new Error('Could not open any wallet from profile'), iden);

    // Open All wallets from profile
    //This could be optional, or opts.onlyOpen = wid
    var wallets = [];
    var remaining = wids.length;
    _.each(wids, function(wid) {
      iden.openWallet(wid, function(err, w) {
        if (err) {
          log.error('Cound not open wallet id:' + wid + '. Skipping')
          iden.profile.deleteWallet(wid, function() {});
        } else {
          log.info('Open wallet id:' + wid + ' opened');
          wallets.push(w);
        }
        if (--remaining == 0) {
          var lastFocused = iden.profile.getLastFocusedWallet();
          return cb(err, iden, lastFocused);
        }
      })
    });
  });
};

/**
 * isAvailable
 *
 * @param email
 * @param opts
 * @param cb
 * @return {undefined}
 */
Identity.isAvailable = function(email, opts, cb) {
  console.log('[Identity.js.127:isAvailable:] TODO'); //TODO
  return cb();
};

Identity.prototype.readWallet = function(walletId, readOpts, cb) {
  preconditions.checkArgument(cb);
  var self = this,
    err;
  var obj = {};

  this.storage.getFirst(Wallet.getStorageKey(walletId), {}, function(err, obj) {
    if (err) return cb(err);

    if (!obj)
      return cb(new Error('WNOTFOUND: Wallet not found'));

    var w, err;
    obj.id = walletId;

    try {
      log.debug('## OPENING Wallet: ' + walletId);
      w = Wallet.fromUntrustedObj(obj, readOpts);
    } catch (e) {
      log.debug("ERROR: ", e.message);
      if (e && e.message && e.message.indexOf('MISSOPTS')) {
        err = new Error('WERROR: Could not read: ' + walletId + ': ' + e.message);
      } else {
        err = e;
      }
      w = null;
    }
    return cb(err, w);
  });
};

Identity.prototype.storeWallet = function(w, cb) {
  preconditions.checkArgument(w && _.isObject(w));

  var id = w.getId();
  var val = w.toObj();
  var key = Wallet.getStorageKey(id + '_' + w.getName());

  this.storage.set(key, val, function(err) {
    log.debug('Wallet:' + w.getName() + '  stored');

    if (cb)
      cb(err);
  });
};


/**
 * store
 *
 * @param opts
 * @param cb
 * @return {undefined}
 */
Identity.prototype.store = function(opts, cb) {
  preconditions.checkState(this.profile);

  var self = this;
  self.profile.store(opts, function(err) {
    if (err) return cb(err);

    var l = Object.keys(self.wallets),
      i = 0;
    if (!l) return cb();

    _.each(self.wallets, function(w) {
      self.storeWallet(w, function(err) {
        if (err) return cb(err);

        if (++i == l)
          return cb();
      })
    });
  });
};


Identity.prototype._cleanUp = function() {
  // NOP
};

/**
 * @desc Closes the wallet and disconnects all services
 */
Identity.prototype.close = function(cb) {
  preconditions.checkState(this.profile);

  var l = Object.keys(this.wallets),
    i = 0;
  if (!l) {
    return cb ? cb() : null;
  }

  var self = this;
  _.each(this.wallets, function(w) {
    w.close(function(err) {
      if (err) return cb(err);

      if (++i == l) {
        self._cleanUp();
        if (cb) return cb();
      }
    })
  });
};


/**
 * @desc Imports a wallet from an encrypted base64 object
 * @param {string} base64 - the base64 encoded object
 * @param {string} passphrase - passphrase to decrypt it
 * @param {string[]} skipFields - fields to ignore when importing
 * @return {Wallet}
 */
Identity.prototype.importWallet = function(base64, password, skipFields, cb) {
  var self = this;
  preconditions.checkArgument(password);
  preconditions.checkArgument(cb);

  var obj = this.storage.decrypt(base64, password);

  var readOpts = {
    networkOpts: this.networkOpts,
    blockchainOpts: this.blockchainOpts,
    skipFields: skipFields
  };

  if (!obj) return cb(null);
  var w = Identity._walletFromObj(obj, readOpts);
  this._checkVersion(w.version);
  this.addWallet(w, function(err) {
    if (err) return cb(err, null);
    self.wallets[w.getId()] = w;
    self.store(null, function(err) {
      return cb(err, w);
    });
  });
};

Identity.prototype.closeWallet = function(wid, cb) {
  var w = this.getOpenWallet(wid);
  preconditions.checkState(w, 'Wallet not found');

  var self = this;
  w.close(function(err) {
    delete self.wallets[wid];
    return cb(err);
  });
};

Identity.importFromJson = function(str, password, opts, cb) {
  preconditions.checkArgument(str);
  var json;
  try {
    json = JSON.parse(str);
  } catch (e) {
    return cb('Unable to retrieve json from string', str);
  }

  if (!_.isNumber(json.iterations))
    return cb('BADSTR: Missing iterations');

  if (!json.profile)
    return cb('BADSTR: Missing profile');

  var iden = new Identity(password, opts);
  iden.profile = Profile.import(json.profile, password, iden.storage);

  json.wallets = json.wallets || {};
  var walletInfoBackup = iden.profile.walletInfos;
  iden.profile.walletInfos = {};

  var l = _.size(json.wallets),
    i = 0;

  if (!l)
    return cb(null, iden);

  _.each(json.wallets, function(wstr) {
    iden.importWallet(wstr, password, opts.skipFields, function(err, w) {
      if (err) return cb(err);
      log.debug('Wallet ' + w.getId() + ' imported');

      if (++i == l) {
        iden.profile.walletInfos = walletInfoBackup;
        iden.store(opts, function(err) {
          if (err) {
            return cb(err);
          } else {
            return cb(null, iden, iden.openWallets[0]);
          }
        });
      }
    })
  });
};

/**
 * @desc Return JSON with base64 encoded strings for wallets and profile, and iteration count
 * @return {string} Stringify JSON
 */
Identity.prototype.exportAsJson = function() {
  var ret = {};
  ret.iterations = this.storage.iterations;
  ret.profile = this.profile.export();
  ret.wallets = {};

  _.each(this.wallets, function(w) {
    ret.wallets[w.getId()] = w.export();
  });

  var r = JSON.stringify(ret);
  return r;
};

Identity.prototype.bindWallet = function(w) {
  var self = this;

  self.wallets[w.getId()] = w;
  log.debug('Binding wallet ' + w.getName());

  w.on('hasChange', function() {
    log.debug('<hasChange> Wallet' + w.getName());
    self.storeWallet(w);
  });
};

/**
 * @desc This method prepares options for a new Wallet
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @param {PrivateKey=} opts.privateKey
 * @param {string=} opts.privateKeyHex
 * @param {number} opts.requiredCopayers
 * @param {number} opts.totalCopayers
 * @param {PublicKeyRing=} opts.publicKeyRing
 * @param {string} opts.nickname
 * @param {string} opts.password
 * @TODO: Figure out what is this parameter
 * @param {?} opts.spendUnconfirmed this.walletDefaults.spendUnconfirmed ??
 * @TODO: Figure out in what unit is this reconnect delay.
 * @param {number} opts.reconnectDelay milliseconds?
 * @param {number=} opts.version
 * @param {callback} opts.version
 * @return {Wallet}
 */
Identity.prototype.createWallet = function(opts, cb) {
  preconditions.checkArgument(cb);
  preconditions.checkState(this.profile);

  opts = opts || {};
  opts.networkName = opts.networkName || 'testnet';

  log.debug('### CREATING NEW WALLET.' + (opts.id ? ' USING ID: ' + opts.id : ' NEW ID') + (opts.privateKey ? ' USING PrivateKey: ' + opts.privateKey.getId() : ' NEW PrivateKey'));

  var privOpts = {
    networkName: opts.networkName,
  };

  if (opts.privateKeyHex && opts.privateKeyHex.length > 1) {
    privOpts.extendedPrivateKeyString = opts.privateKeyHex;
  }

  opts.privateKey = opts.privateKey || new PrivateKey(privOpts);

  var requiredCopayers = opts.requiredCopayers || this.walletDefaults.requiredCopayers;
  var totalCopayers = opts.totalCopayers || this.walletDefaults.totalCopayers;
  opts.lockTimeoutMin = this.walletDefaults.idleDurationMin;

  opts.publicKeyRing = opts.publicKeyRing || new PublicKeyRing({
    networkName: opts.networkName,
    requiredCopayers: requiredCopayers,
    totalCopayers: totalCopayers,
  });
  opts.publicKeyRing.addCopayer(
    opts.privateKey.deriveBIP45Branch().extendedPublicKeyString(),
    opts.nickname || this.profile.getName()
  );
  log.debug('\t### PublicKeyRing Initialized');

  opts.txProposals = opts.txProposals || new TxProposals({
    networkName: opts.networkName,
  });
  log.debug('\t### TxProposals Initialized');


  opts.networkOpts = this.networkOpts;
  opts.blockchainOpts = this.blockchainOpts;

  opts.spendUnconfirmed = opts.spendUnconfirmed || this.walletDefaults.spendUnconfirmed;
  opts.reconnectDelay = opts.reconnectDelay || this.walletDefaults.reconnectDelay;
  opts.requiredCopayers = requiredCopayers;
  opts.totalCopayers = totalCopayers;
  opts.version = opts.version || this.version;

  var self = this;
  var w = Identity._newWallet(opts);
  this.addWallet(w, function(err) {
    if (err) return cb(err);
    self.bindWallet(w);
    if (self.pluginManager.get && self.pluginManager.get('remote-backup')) {
      self.pluginManager.get('remote-backup').store(self, self.insightSaveOpts, _.noop);
    }
    w.netStart();
    return cb(null, w);
  });
};


// add wallet (import)
Identity.prototype.addWallet = function(wallet, cb) {
  preconditions.checkArgument(wallet);
  preconditions.checkArgument(wallet.getId);
  preconditions.checkArgument(cb);
  preconditions.checkState(this.profile);

  var self = this;
  self.profile.addWallet(wallet.getId(), {
    name: wallet.name
  }, function(err) {
    if (err) return cb(err);
    self.storeWallet(wallet, function(err) {
      return cb(err);
    });
  });
};


/**
 * @desc Checks if a version is compatible with the current version
 * @param {string} inVersion - a version, with major, minor, and revision, period-separated (x.y.z)
 * @throws {Error} if there's a major version difference
 */
Identity.prototype._checkVersion = function(inVersion) {
  if (inVersion) {
    var thisV = this.version.split('.');
    var thisV0 = parseInt(thisV[0]);
    var inV = inVersion.split('.');
    var inV0 = parseInt(inV[0]);
  }

  //We only check for major version differences
  if (thisV0 < inV0) {
    throw new Error('Major difference in software versions' +
      '. Received:' + inVersion +
      '. Current version:' + this.version +
      '. Aborting.');
  }
};

/**
 * @desc Retrieve a wallet from the storage
 * @param {string} walletId - the id of the wallet
 * @param {function} callback (err, {Wallet})
 * @return
 */
Identity.prototype.openWallet = function(walletId, cb) {
  preconditions.checkArgument(cb);
  preconditions.checkState(this.storage.hasPassphrase());

  var self = this;
  // TODO
  //  self.migrateWallet(walletId, password, function() {
  //

  self.readWallet(walletId, {
    networkOpts: this.networkOpts,
    blockchainOpts: this.blockchainOpts
  }, function(err, w) {
    if (err) return cb(err);
    self.bindWallet(w);
    self.storeWallet(w, function(err) {
      w.netStart();
      return cb(err, w);
    });
  });
  //  });
};


Identity.prototype.getOpenWallet = function(id) {
  return this.wallets[id];
};


Identity.prototype.listWallets = function() {
  var ret = this.profile.listWallets();
  return ret;
};

/**
 * @desc Deletes this wallet. This involves removing it from the storage instance
 * @param {string} walletId
 * @callback cb
 * @return {err}
 */
Identity.prototype.deleteWallet = function(walletId, cb) {
  var self = this;
  Identity._walletDelete(walletId, this.storage, function(err) {
    if (err) return cb(err);
    self.profile.deleteWallet(walletId, function(err) {
      return cb(err);
    });
  })
};

/**
 * @desc Pass through to {@link Wallet#secret}
 */
Identity.prototype.decodeSecret = function(secret) {
  try {
    return Wallet.decodeSecret(secret);
  } catch (e) {
    return false;
  }
};

/**
 * @callback walletCreationCallback
 * @param {?} err - an error, if any, that happened during the wallet creation
 * @param {Wallet=} wallet - the wallet created
 */

/**
 * @desc Start the network functionality.
 *
 * Start up the Network instance and try to join a wallet defined by the
 * parameter <tt>secret</tt> using the parameter <tt>nickname</tt>. Encode
 * information locally using <tt>passphrase</tt>. <tt>privateHex</tt> is the
 * private extended master key. <tt>cb</tt> has two params: error and wallet.
 *
 * @param {object} opts
 * @param {string} opts.secret - the wallet secret
 * @param {string} opts.nickname - a nickname for the current user
 * @param {string} opts.privateHex - the private extended master key
 * @param {walletCreationCallback} cb - a callback
 */
Identity.prototype.joinWallet = function(opts, cb) {
  preconditions.checkArgument(opts);
  preconditions.checkArgument(opts.secret);
  preconditions.checkArgument(cb);
  var self = this;
  var decodedSecret = this.decodeSecret(opts.secret);
  if (!decodedSecret || !decodedSecret.networkName || !decodedSecret.pubKey) {
    return cb('badSecret');
  }

  var privOpts = {
    networkName: decodedSecret.networkName,
  };

  if (opts.privateHex && opts.privateHex.length > 1) {
    privOpts.extendedPrivateKeyString = opts.privateHex;
  }

  //Create our PrivateK
  var privateKey = new PrivateKey(privOpts);
  log.debug('\t### PrivateKey Initialized');
  var joinOpts = {
    copayerId: privateKey.getId(),
    privkey: privateKey.getIdPriv(),
    key: privateKey.getIdKey(),
    secretNumber: decodedSecret.secretNumber,
  };


  var joinNetwork = Identity._newAsync(this.networkOpts[decodedSecret.networkName]);

  // This is a hack to reconize if the connection was rejected or the peer wasn't there.
  var connectedOnce = false;
  joinNetwork.on('connected', function(sender, data) {
    connectedOnce = true;
  });

  joinNetwork.on('connect_error', function() {
    return cb('connectionError');
  });

  joinNetwork.on('serverError', function() {
    return cb('joinError');
  });

  joinNetwork.start(joinOpts, function() {

    joinNetwork.greet(decodedSecret.pubKey, joinOpts.secretNumber);
    joinNetwork.on('data', function(sender, data) {
      if (data.type === 'walletId' && data.opts) {
        if (!data.networkName || data.networkName !== decodedSecret.networkName) {
          return cb('badNetwork');
        }
        data.opts.networkName = data.networkName;

        var walletOpts = _.clone(data.opts);
        walletOpts.id = data.walletId;
        walletOpts.network = joinNetwork;

        walletOpts.privateKey = privateKey;
        walletOpts.nickname = opts.nickname || self.profile.getName();

        if (opts.password)
          walletOpts.password = opts.password;

        self.createWallet(walletOpts, function(err, w) {
          if (w) {
            w.sendWalletReady(decodedSecret.pubKey);
          } else {
            if (!err) err = 'walletFull';
            log.info(err);
          }
          return cb(err, w);
        });
      }
    });
  });
};


module.exports = Identity;
