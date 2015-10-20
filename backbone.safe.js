/**
 * Safe - support for storing Backbone.Model to localstorage/sessionstorage
 * 		  using the 'set' method of Model
 *
 * @constructor - use the key 'safe' to define unique storage key for backbone safe
 *
 * 				examples:
 *
 *				// simple defintion for safe
 *			 	Backbone.Model.extend({ key: 'my-unique-key' });
 *
 * 					// advanced defintion for safe with options
 *	  			Backbone.Model.extend({
 *	  			
 *		 				safe: {
 *		 					key: 'my-unique-key',
 *		 					options: {
 *		 						reload: true
 *		 					}
 *		 				}	
 * 
 *	  			})
 * 
 * @requires Backbone.js, Underscore.js
 * @param {string} uniqueID - the name of the storage you'de like to use
 * @param {object} context  - the Backbone.Model instance reference
 * @param {object} options - (optional) configuration for setting up various features
 *						 - {boolean} reload - true to reload (before initialize) data from local/session storage if exists
 *
 * @author Oren Farhi, http://orizens.com
 *
 * @version 0.6.1
 *
 */
(function (global, factory) {
  if (typeof exports === "object" && typeof module !== 'undefined') {
  	module.exports = factory(require("underscore"), require("backbone"));
  } else if (typeof define === "function" && define.amd) {
  	define(["underscore", "backbone"], factory);
  } else {
  	global.Backbone.Safe = factory(global._, global.Backbone);
  }
})(this, function (_, Backbone) {
	
	// if Underscore or Backbone have not been loaded
	// exit to prevent js errors
	if (!_ || !Backbone || !JSON) {
		return;
	}

	var STORE_DEBOUNCE_DELAY = 100;
	var STORE_AFTER_QUOTA_ERROR_DELAY = 700;

	// factory for creating extend replacement for Backbone Objects
	function BackboneExtender(bbObject, plugins) {
		var thisExtender = this;
		this.plugins = plugins;
		bbObject["extend"] = _.wrap(bbObject["extend"], function(sourceExtend, config){
			config = config || {}
			// thisExtender.config = config;
			var _sourceFn = config.initialize || this.prototype.initialize || function(){};
			config.initialize = function(){
				var args = [].slice.call(arguments);
				thisExtender.config = config;
				thisExtender.applyPlugins(this, args);
				_sourceFn.apply(this, args);
			};
			return sourceExtend.call(this, config);
		});
	};

	BackboneExtender.prototype.applyPlugins = function(instance, args) {
		var config = this.config,
			plugins = this.plugins,
			args = args || [];
		// run the plugins on this
		_.each(plugins, function(plugFn){
			plugFn.call(instance, config, args);
		});
	};

	BackboneExtender.prototype.addPlug = function(plugFn) {
		this.plugins.push(plugFn);
	};

	var SafePlug = function (config, args) {
		var storageKey,
			storageType;
			
		// create safe if exist as key
		if (config && config.safe) {
			
			// handle key, value safe
			storageKey = config.safe.key ? config.safe.key : config.safe;
			// get which storage should be use
			storageType = config.safe.type ? config.safe.type : 'local';
			
			Backbone.Safe.create(storageKey, this, storageType, config.safe.options || { reload: true });
		}
	}
	// extend Model & Collection constructor to handle safe initialization
	// Backbone.Model.extend = _.wrap(Backbone.Model.extend, BackboneExtender)
	var modelSafePlugin = new BackboneExtender(Backbone.Model, [ SafePlug ]);
	var collectionSafePlugin = new BackboneExtender(Backbone.Collection, [ SafePlug ]);


	Backbone.Safe = function(uniqueID, context, type, options) {

		// parsing options settings
		this._reload = options && options.reload && options.reload === true;

		this.uid = uniqueID;
		this.type = type;
		this.context = context;
		this.isCollection = context.models && context.add;
		this.maxCollectionLength = options ? (options.maxCollectionLength || false) : false; 

		// mixins for collection and model
		var collection = {
			
			// events that Safe is listening in order to
			// trigger save to storage
			events: 'add reset change sort remove',

			// the value to be used when cleaning the safe
			emptyValue: '[]',

			reload: function(options) {
				context.add(this.getData(), options);
			},

			fetch: function(options) {
				var fetchFromSafe = options && options.from;
				if (fetchFromSafe && fetchFromSafe === "safe") {
					this.safe.reload(options);
				} else {
					Backbone.Collection.prototype.fetch.apply(this, arguments);
				}
			},

			toJSON: function(model) {
				var data;

				if (model.collection) { // From add and remove, this will be a model
					data = model.collection.toJSON();
				}
				else {
					data = model.toJSON();
				}

				if (this.maxCollectionLength) {
					data = data.slice(-this.maxCollectionLength);
				}

				return data;
			}
		};

		var model = { 
			events: 'change',

			emptyValue: '{}',

			reload: function(options) {
				context.set(this.getData(), options);
			},

			// options = { from: "safe" }
			fetch: function (options) {
				var fetchFromSafe = options && options.from;
				if (fetchFromSafe && fetchFromSafe === "safe") {
					this.safe.reload(options);
				} else {
					Backbone.Model.prototype.fetch.apply(this, arguments);
				}
			},

			toJSON: function(model) {
				return model.toJSON();
			}
		};

		// attach relevant object to Safe prototype
		_.extend( this, this.isCollection ? collection : model );

		// if the uid doesn't exist, create it
		this.ensureUID();

		// These are the lines that are responsible for
		// loading the saved data from the storage to the model
		//
		// the data is loaded before the Safe binds to change events
		// storage exist ? -> save to model
		// if it's a collection - use add
		if (this._reload) {
			this.reload();
		}

		// attach Backbone custom methods
		_.extend(context, _.pick(this, ['fetch']));
		// listen to any change event and cache it
		this.debouncedStore = _.throttle(_.bind(this.store, this, context), STORE_DEBOUNCE_DELAY);
		context.on(this.events, this.debouncedStore, this);
		// adding destroy handler
		context.on('destroy', this.destroy, this);
	};

	Backbone.Safe.prototype = {
		
		/**
		 * creates a storage item with the provided
		 * UID if not exist
		 */
		ensureUID: function() {
			if (_.isNull(this.getData())){
				this.create();
			}
		},

		create: function() {
		  try {
				this.storage().setItem(this.uid, this.emptyValue);
			} catch (e) {
				if (e.name == 'NS_ERROR_DOM_QUOTA_REACHED' || e.code == 22 || e.number === -2147024882) {
	        this.context.trigger('safeQuotaError');

	       	setTimeout(_.bind(function() {
	        	this.create();
	        }, this), STORE_AFTER_QUOTA_ERROR_DELAY);
	      }
			}
		},

		/*
		 * @bbDataObj {collection/model}
		 */
		store: function(bbDataObj) {
			try {
				this.storage()
					.setItem(this.uid, JSON.stringify( this.toJSON( bbDataObj )));
			} catch (e) {
				if (e.name == 'NS_ERROR_DOM_QUOTA_REACHED' || e.code == 22 || e.number === -2147024882) {
	        this.context.trigger('safeQuotaError');

	        setTimeout(_.bind(function() {
	        	this.store(bbDataObj);
	        }, this), STORE_AFTER_QUOTA_ERROR_DELAY);
	      }
			}
		},

		storage: function() {
			return this.type == 'session' ? sessionStorage :  localStorage;
		},

		/**
		 * returns json object of the local saved data
		 * @return {json}
		 */
		getData: function() {
			// JSON.parse can't be run with an empty string
			this._current = this.storage().getItem(this.uid);
			try {
				return this._current ? JSON.parse(this._current) : this._current;
			} catch (e) {
				return {};
			}
		},

		// set the local storage key to the empty value
		reset: function() {
			this.create();
		},

		// removes the key from the localstorage
		destroy: function() {
			this.storage().removeItem( this.uid );
		}
	};

	// factory method
	Backbone.Safe.create = function( uniqueID, context, type, options) {
		if (uniqueID && context) {
			context.safe = new Backbone.Safe(uniqueID, context, type, options);
		}
	};

	return Backbone.Safe;

});