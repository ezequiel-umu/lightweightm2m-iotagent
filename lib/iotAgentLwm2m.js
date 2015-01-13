/*
 * Copyright 2014 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of lightweightM2M-iotagent
 *
 * lightweightM2M-iotagent is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * lightweightM2M-iotagent is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with lightweightM2M-iotagent.
 * If not, seehttp://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::[contacto@tid.es]
 */
'use strict';

var iotAgentLib = require('fiware-iotagent-lib'),
    lwm2mLib = require('iotagent-lwm2m-lib').server,
    lwm2mUtils = require('./lwm2mUtils'),
    ngsiUtils = require('./ngsiUtils'),
    logger = require('logops'),
    async = require('async'),
    errors = require('./errors'),
    apply = async.apply,
    config,
    context = {
        op: 'IOTAgent.Global'
    },
    serverInfo;


function ngsiUpdateHandler(id, type, attributes, callback) {
    logger.debug(context, 'Handling device data update from the northbound for device [%s] of type [%s]', id, type);
    logger.debug(context, 'New attributes;\n%s', attributes);

    callback(null);
}

function ngsiQueryHandler(id, type, attributes, callback) {
    var name = id.substring(0, id.indexOf(':'));

    logger.debug(context, 'Handling device data query from the northbound for device [%s] of type [%s]', id, type);
    logger.debug(context, 'New attributes;\n%s', attributes);

    function readAttribute(deviceId, attribute, innerCallback) {
        if (config.ngsi.types[type].lwm2mResourceMapping[attribute]) {
            lwm2mLib.read(
                deviceId,
                config.ngsi.types[type].lwm2mResourceMapping[attribute].objectType,
                config.ngsi.types[type].lwm2mResourceMapping[attribute].objectInstance,
                config.ngsi.types[type].lwm2mResourceMapping[attribute].objectResource,
                innerCallback);

        } else {
            innerCallback(new Error('Couldn\'t find LWM2M mapping for attributes'));
        }
    }

    function readAttributes(device, innerCallback) {
        async.map(
            attributes,
            async.apply(readAttribute, device.id),
            innerCallback);
    }

    function createContextElement(attributeValues, callback) {
        var contextElement = {
            type: type,
            isPattern: false,
            id: id,
            attributes: []
        };

        for (var i = 0; i < attributes.length; i++) {
            var attributeType = 'string';

            for (var j=0; j < config.ngsi.types[type].lazy.length; j++) {
                if (config.ngsi.types[type].lazy[j].name === attributes[i]) {
                    attributeType = config.ngsi.types[type].lazy[j].type;
                }
            }

            contextElement.attributes.push({
                    name: attributes[i],
                    type: attributeType,
                    value: attributeValues[i]
            });
        }

        callback(null, contextElement);
    }

    async.waterfall([
        async.apply(lwm2mLib.getRegistry().getByName, name),
        readAttributes,
        createContextElement
    ], callback);
}

function activeDataHandler(registeredDevice, name, type, value) {
    var attributes = [
        {
            name: name,
            type: type,
            value: value
        }
    ];

    logger.debug('Handling data from device [%s]', registeredDevice.id);

    ngsiUtils.updateEntity(
        config.ngsi.contextBroker.host,
        config.ngsi.contextBroker.port,
        registeredDevice.service,
        registeredDevice.subservice,
        registeredDevice.name,
        registeredDevice.type,
        attributes,
        function handleUpdateEntity(error, response, body) {
            if (error) {
                logger.error('Unknown error connecting with the Context Broker: ' + error);
            } else if (response.statusCode !== 200) {
                logger.error('Transport error connecting with the Context Broker: ' + error);
            } else if (body && body.errorCode) {
                logger.debug('Application error connecting with the Context Broker:\n\n%j\n', body);
            } else {
                logger.debug('Data handled successfully');
            }
        }
    );
}

/**
 * Handles a registration from the Lightweight M2M device. There are three scenarios:
 * - If the device has been registered before in the device registry, there is no registration needed.
 * - If the device is not registered, it should come with a URL, that can be used to guess its type. Once the type
 * has been detected, the rest of the information can be retrieved from the config file.
 *
 * @param endpoint
 * @param lifetime
 * @param version
 * @param binding
 * @param payload
 * @param callback
 */
function registrationHandler(endpoint, lifetime, version, binding, payload, callback) {
    logger.debug(context, 'Handling registration of the device');

    function mapConfig(device, callback) {
        logger.debug(context, 'Mapping device found to NGSI register');

        if (device.type) {
            callback(
                null,
                device.name + ':' + device.type,
                device.type,
                null,
                config.ngsi.types[device.type].service,
                config.ngsi.types[device.type].subservice,
                config.ngsi.types[device.type].lazy,
                device.id
            );
        } else {
            logger.error(context, 'Type not found for device. It won\'t be given a connection');
            callback('Type not found for device');
        }
    }

    function observeActiveAttributes(registeredDevice, callback) {
        var objects = lwm2mUtils.parseObjectUriList(payload),
            activeAttributes = config.ngsi.types[registeredDevice.type].active,
            observationList = [];

        for (var i = 0; i < activeAttributes.length; i++) {
            var lwm2mMapping = config
                .ngsi
                .types[registeredDevice.type]
                .lwm2mResourceMapping[activeAttributes[i].name];

            if (lwm2mMapping) {
                var mappedUri = '/' + lwm2mMapping.objectType + '/' + lwm2mMapping.objectInstance;

                for (var j = 0; j < objects.length; j++) {
                    if (mappedUri === objects[j]) {
                        observationList.push(async.apply(lwm2mLib.observe,
                            registeredDevice.internalId,
                            lwm2mMapping.objectType,
                            lwm2mMapping.objectInstance,
                            lwm2mMapping.objectResource,
                            apply(activeDataHandler,
                                registeredDevice,
                                activeAttributes[i].name,
                                activeAttributes[i].type)
                        ));
                    }
                }
            }
        }

        async.series(observationList, function (error) {
            if (error) {
                logger.error('Could not complete the observer creation processes due to the following error: ' + error);
                callback(error);
            } else {
                callback(null);
            }
        });
    }

    iotAgentLib.getDevice(endpoint, function (error, device) {
        if (error && error.name && error.name === 'ENTITY_NOT_FOUND') {
            logger.debug(context, 'Device register not found. Creating new device.');
            async.waterfall([
                async.apply(lwm2mLib.getRegistry().getByName, endpoint),
                mapConfig,
                iotAgentLib.register,
                observeActiveAttributes
            ], callback);
        } else if (error) {
            logger.debug(context, 'An error was encountered registering device.');
            callback(error);
        } else if (device) {
            logger.debug(context, 'Preregistered device found.');
            callback(null);
        } else {
            logger.debug(context, 'Impossible to find a proper way to deal with the registration');
            callback(
                new errors.UnknownInternalError('Impossible to find a proper way of dealing with the registration'));
        }
    });
}

function unregistrationHandler(device, callback) {
    logger.debug(context, 'Handling unregistration of the device');

    iotAgentLib.unregister(device.name + ':' + device.type, device.type, callback);
}

function updateRegistration(object, callback) {
    logger.debug(context, 'Handling update registration of the device');

    callback(null);
}

function initialize(callback) {
    iotAgentLib.setDataUpdateHandler(ngsiUpdateHandler);
    iotAgentLib.setDataQueryHandler(ngsiQueryHandler);

    lwm2mLib.setHandler(serverInfo, 'registration', registrationHandler);
    lwm2mLib.setHandler(serverInfo, 'unregistration', unregistrationHandler);
    lwm2mLib.setHandler(serverInfo, 'updateRegistration', updateRegistration);

    logger.info(context, 'Agent started');
    callback();
}

function start(localConfig, callback) {
    config = localConfig;
    async.series([
        apply(lwm2mLib.start, localConfig.lwm2m),
        apply(iotAgentLib.activate, localConfig.ngsi)
    ], function (error, results) {
        if (error) {
            callback(error);
        } else {
            serverInfo = results[0];
            initialize(callback);
        }
    });
}

function stop(callback) {
    async.series([
        apply(lwm2mLib.stop, serverInfo),
        iotAgentLib.deactivate
    ], callback);
}

exports.start = start;
exports.stop = stop;