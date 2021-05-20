/**
 *
 *      iobroker extron (SIS) Adapter
 *
 *      Copyright (c) 2020-2021, Bannsaenger <bannsaenger@gmx.de>
 *
 *      CC-NC-BY 4.0 License
 *
 */

// The adapter-core module gives you access to the core ioBroker functions
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// @ts-ignore
const fs = require('fs');
// @ts-ignore
const Client = require('ssh2').Client;
const errCodes = {
    'E01' : 'Invalid input channel number (out of range)',
    'E10' : 'Unrecognized command',
    'E11' : 'Invalid preset number (out of range)',
    'E12' : 'Invalid port/output number (out of range)',
    'E13' : 'Invalid parameter',
    'E14' : 'Not valid for this configuration',
    'E17' : 'Invalid command for signal type',
    'E18' : 'System/command timed out',
    'E22' : 'Busy',
    'E24' : 'Privilege violation',
    'E25' : 'Device not present',
    'E26' : 'Maximum number of connections exceeded',
    'E27' : 'Invalid event number',
    'E28' : 'Bad filename or file not found',
    'E31' : 'Attempt to break port passthrough when not set'
};

class Extron extends utils.Adapter {

    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'extron',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        // Send buffer (Array of commands to send)
        this.sendBuffer = [];
        // Status variables
        this.isDeviceChecked = false;       // will be true if device sends banner and will be verified
        this.isVerboseMode = false;         // will be true if verbose mode 3 is active
        this.initDone = false;              // will be true if all init is done
        this.versionSet = false;            // will be true if the version is once set in the db
        this.statusRequested = false;       // will be true if device status has been requested after init
        this.clientReady = false;           // will be true if device connection is ready
        // Some timers and intervalls
        //this.intervallQueryStatus = class Timer {};
        this.timers = {};
        // Create a client socket to connect to the device
        // first implementation only ssh
        this.debugSSH = false;
        // debug option for full ssh debug log on adapter.log.silly
        this.client = new Client();
        // the shell stream
        this.stream = undefined;
        this.streamAvailable = true;    // if false wait for continue event
        this.stateList = [];             // will be filled with all existing states
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        const self = this;
        try {
            // Initialize your adapter here
            const startTime = Date.now();

            // Reset the connection indicator during startup
            self.setState('info.connection', false, true);

            // The adapters config (in the instance object everything under the attribute "native") is accessible via
            // this.config:
            self.log.info('configured host/port: ' + self.config.host + ':' + self.config.port);


            // read Objects template for object generation
            this.objectsTemplate = JSON.parse(fs.readFileSync(__dirname + '/admin/lib/objects_templates.json', 'utf8'));
            // read devices for device check
            this.devices = JSON.parse(fs.readFileSync(__dirname + '/admin/lib/device_mapping.json', 'utf8'));

            /*
            * For every state in the system there has to be also an object of type state
            */
            await self.createDatabaseAsync();
            await self.createStatesListAsync();

            // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
            // this.subscribeStates('testVariable');
            self.subscribeStates('*');

            /*
                setState examples
                you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
            */
            // the variable testVariable is set to true as command (ack=false)
            //await this.setStateAsync('testVariable', true);

            // same thing, but the value is flagged "ack"
            // ack should be always set to true if the value is received from or acknowledged from the target system
            //await this.setStateAsync('testVariable', { val: true, ack: true });

            // same thing, but the state is deleted after 30s (getState will return null afterwards)
            //await this.setStateAsync('testVariable', { val: true, ack: true, expire: 30 });

            // Client callbacks
            self.client.on('keyboard-interactive', this.onClientKeyboard.bind(this));
            self.client.on('ready', this.onClientReady.bind(this));
            self.client.on('banner', this.onClientBanner.bind(this));
            self.client.on('close', this.onClientClose.bind(this));
            self.client.on('error', this.onClientError.bind(this));
            self.client.on('end', this.onClientEnd.bind(this));

            self.log.info(`Extron took ${Date.now() - startTime}ms to initialize and setup db`);

            self.clientConnect();
        } catch (err) {
            self.errorHandler(err, 'onReady');
        }
    }

    /**
     * try to connect to the device
     */
    clientConnect() {
        const self = this;
        try {
            self.log.info('Extron connecting to: ' + self.config.host + ':' + self.config.port);
            self.client.connect({
                'host': self.config.host,
                'port': Number(self.config.port),
                'username': self.config.user,
                'password': self.config.pass,
                'keepaliveInterval': 5000,
                'debug': self.debugSSH ? self.log.silly : undefined,
                'readyTimeout': 5000,
                'tryKeyboard': true
            });
        } catch (err) {
            self.errorHandler(err, 'clientConnect');
        }
    }

    /**
     * called if keyboard authentication must be fullfilled
     * @param {string} _name
     * @param {string} _instructions
     * @param {string} _instructionsLang
     * @param {array} _prompts
     * @param {function} finish
     */
    onClientKeyboard(_name, _instructions, _instructionsLang, _prompts, finish) {
        const self = this;
        try {
            this.log.info('Extron keyboard autentication in progress. Send back password');
            finish([this.config.pass]);
        } catch (err) {
            self.errorHandler(err, 'onClientKeyboard');
        }
    }

    /**
     * called if client is successfully connected
     */
    onClientReady() {
        const self = this;
        try {
            self.log.info('Extron is authenticated successfully, now open the stream');
            self.client.shell(function (error, channel) {
                try {
                    if (error) throw error;
                    self.log.info('Extron shell established channel');
                    self.stream = channel;
                    self.stream.on('error', self.onStreamError.bind(self));
                    self.stream.on('close', self.onStreamClose.bind(self));
                    self.stream.on('data', self.onStreamData.bind(self));
                    self.stream.on('continue', self.onStreamContinue.bind(self));
                    // Set the connection indicator after authentication and an open stream
                    self.log.info('Extron connected');
                    self.setState('info.connection', true, true);
                } catch (err) {
                    self.errorHandler(err, 'onClientReady');
                }
            });
        } catch (err) {
            self.errorHandler(err, 'onClientReady');
        }
    }

    /**
     * called if client has recieved a banner
     * @param {string} message
     * @param {string} language
     */
    onClientBanner(message, language) {
        this.log.info('Extron sent back banner: "' + message + '" in language: "' + language + '"');
    }

    /**
     * called if client is closed
     */
    onClientClose() {
        const self = this;
        try {
            self.log.info('Extron client closed');
            // Reset the connection indicator
            self.setState('info.connection', false, true);
            self.clientReady = false;
        } catch (err) {
            self.errorHandler(err, 'onClientClose');
        }
    }
    /**
     * called if the socket is disconnected
     */
    onClientEnd() {
        const self = this;
        try {
            self.log.info('Extron client socket disconnected');
        } catch (err) {
            self.errorHandler(err, 'onClientEnd');
        }
    }
    /**
     * called if client receives an error
     * @param {any} err
     */
    onClientError(err) {
        this.errorHandler(err, 'onClientError');
    }

    /**
     * called to send data to the stream
     * @param {string} data
     */
    streamSend(data) {
        const self = this;
        try {
            if (self.streamAvailable) {
                self.log.debug('Extron sends data to the stream: "' + self.decodeBufferToLog(data) + '"');
                self.streamAvailable = self.stream.write(data);
            } else {
                self.log.debug('Extron push data to the send buffer: "' + self.decodeBufferToLog(data) + '"');
                self.sendBuffer.push(data);
            }
        } catch (err) {
            self.errorHandler(err, 'streamSend');
        }
    }

    /**
     * called if stream receives data
     * @param {string | Uint8Array} data
     */
    async onStreamData(data) {
        const self = this;
        try {
            self.log.debug('Extron got data: "' + self.decodeBufferToLog(data) + '"');

            if (!self.isDeviceChecked) {        // the first data has to be the banner with device info
                if (data.toString().includes(self.devices[self.config.device].name)) {
                    self.isDeviceChecked = true;
                    if (!self.isVerboseMode) {          // enter the verbose mode
                        self.extronSwitchMode();
                        return;
                    }
                } else {
                    throw { 'message': 'Device mismatch error',
                        'stack'  : 'Please recreate the instance or connect to the correct device' };
                }
                return;
            }
            // iterate through multiple answers connected via [LF]
            for (const cmdPart of data.toString().split('\n')) {

                if (cmdPart.includes('3CV')) {
                    self.log.debug('Extron device switched to verbose mode 3');
                    self.isVerboseMode = true;
                    return;
                }
                if (cmdPart.includes('Vrb3')) {
                    self.log.debug('Extron device entered verbose mode 3');
                    self.isVerboseMode = true;
                    if (!self.initDone) {
                        this.streamSend('Q');       // query Version
                        this.streamSend('1I');      // query Model
                        this.streamSend('WCN\r');   // query deviceName
                        self.initDone = true;
                        self.timers.intervallQueryStatus = setInterval(self.extronQueryStatus.bind(self), self.config.pollDelay);
                        self.getDeviceStatus();
                    }
                    return;
                }
                const answer = cmdPart.replace(/[\r\n]/gm, '');
                // Error handling
                if (answer.match(/E\d\d/gim)) {    // received an error
                    throw { 'message': 'Error response from device',
                        'stack'  : errCodes[answer] };
                }
                // lookup the command
                const matchArray = answer.match(/([A-Z][a-z]+[A-Z]|\w{3})(\d*)\*{0,1},{0,1} {0,1}(.*)/i);
                if (matchArray) {       // if any match
                    const command = matchArray[1].toUpperCase();
                    const ext1 = matchArray[2] ? matchArray[2] : '';
                    const ext2 = matchArray[3] ? matchArray[3] : '';

                    switch (command) {
                        case 'VER':             // received a Version (answer to status query)
                            self.log.silly(`Extron got version: "${ext2}"`);
                            if (!self.versionSet) {
                                self.versionSet = true;
                                self.setState('device.version', ext2, true);
                            }
                            break;

                        case 'IPN':             // received a device name
                            self.log.silly(`Extron got devicename: "${ext2}"`);
                            self.setState('device.name', ext2, true);
                            break;

                        case 'INF':             // received a device model
                            self.log.silly(`Extron got device model: "${ext2}"`);
                            self.setState('device.model', ext2, true);
                            break;

                        case 'DSM':             // received a mute command
                        case 'DSG':             // received a gain level
                            self.log.silly(`Extron got mute/gain ${command} from OID: "${ext1}" value: ${ext2}`);
                            self.setGain(command, ext1, ext2);
                            break;

                        case 'DSD':             //received a set source command
                            self.log.silly(`Extron got source ${command} from OID: "${ext1}" value: "${ext2}"`);
                            self.setSource(ext1, ext2);
                            break;

                        case 'PLAY':             //received a play mode command
                            self.log.silly(`Extron got play mode ${command} for Player: "${ext1}" value: "${ext2}"`);
                            self.setPlayMode(ext1, ext2);
                            break;

                        case 'CPLYA':           //received a file association to a player
                            self.log.silly(`Extron got filename for Player: "${ext1}" value: "${ext2}"`);
                            self.setFileName(ext1, ext2);
                            break;

                        case 'CPLYM':           //received a set repeat mode command
                            self.log.silly(`Extron got repeat mode ${command} for Player: "${ext1}" value: "${ext2}"`);
                            self.setRepeatMode(ext1, ext2);
                            break;

                    }
                } else {
                    if (answer != 'Q') {
                        self.log.silly('Extron received data which cannot be handled "' + answer + '"');
                    }
                }
            }
        } catch (err) {
            self.errorHandler(err, 'onStreamData');
            if (err.message === 'Device mismatch error') self.terminate('Device mismatch error');
        }
    }

    /**
     * called if stream receives data
     * @param {string | Uint8Array} data
     */
    decodeBufferToLog(data) {
        const self = this;
        try {
            let retString = '';
            let dataString = '';
            if (typeof(data) === 'string')  {
                dataString = data;
            } else {
                dataString = data.toString();
            }
            for (let i = 0; i < dataString.length ; i++) {
                switch (dataString.charCodeAt(i)) {
                    case 10:
                        retString += '[LF]';
                        break;

                    case 13:
                        retString += '[CR]';
                        break;

                    case 27:
                        retString += '[ESC]';
                        break;

                    case 127:
                        retString += '[DEL]';
                        break;

                    default:
                        retString += dataString[i];
                        break;

                }
            }
            return retString;
        } catch (err) {
            self.errorHandler(err, 'decodeBufferToLog');
        }
    }

    /**
     * called if stream is ready to send new data
     */
    async onStreamContinue() {
        const self = this;
        try {
            self.log.silly('Extron stream can continue');
            self.streamSend(self.sendBuffer.pop());
        } catch (err) {
            self.errorHandler(err, 'onStreamContinue');
        }
    }
    /**
     * called if stream receives an error
     * @param {any} err
     */
    onStreamError(err) {
        this.errorHandler(err, 'onStreamError');
    }
    /**
     * called if stream is closed
     */
    onStreamClose() {
        const self = this;
        try {
            self.log.info('Extron stream closed');
            self.client.end();
        } catch (err) {
            this.errorHandler(err, 'onStreamClose');
        }
    }

    /**
     * called to switch the verbose mode
     */
    extronSwitchMode() {
        const self = this;
        try {
            self.log.debug('Extron switching to verbose mode 3');
            self.streamSend('W3CV\r');
        } catch (err) {
            this.errorHandler(err, 'extronSwitchMode');
        }
    }
    /**
     * called to send a status query
     */
    extronQueryStatus() {
        const self = this;
        try {
            self.log.debug('Extron send a status query');
            self.streamSend('Q');
        } catch (err) {
            this.errorHandler(err, 'extronQueryStatus');
        }
    }
    /**
     * called to set up the database dependant on the device type
     */
    async createDatabaseAsync() {
        const self = this;
        try {
            // create the common section
            for (const element of self.objectsTemplate.common) {
                await self.setObjectNotExistsAsync(element._id, element);
            }
            // maybe if a audio device
            if (self.devices[self.config.device] && self.devices[self.config.device].in) {
                // at this point the device has inputs
                await self.setObjectNotExistsAsync('in', {
                    'type': 'folder',
                    'common': {
                        'name': 'All input types'
                    },
                    'native': {}
                });
                for (const inputs of Object.keys(self.devices[self.config.device].in)) {
                    // create input folder, key name is the folder id
                    await self.setObjectNotExistsAsync(`in.${inputs}`, {
                        'type': 'folder',
                        'common': {
                            'name': self.devices[self.config.device].in[inputs].name
                        },
                        'native': {}
                    });
                    // for each input type create the amount of inputs
                    for (let i = 1; i <= self.devices[self.config.device].in[inputs].amount; i++) {
                        const actInput = `in.${inputs}.${('00' + i.toString()).slice(-2)}`;
                        // create the input folder
                        await self.setObjectNotExistsAsync(actInput, self.objectsTemplate.input);
                        // and the common structure of an input depending on type
                        switch (inputs) {

                            case 'auxInputs' :
                                for (const element of self.objectsTemplate.auxInputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'inputs' :
                                for (const element of self.objectsTemplate.inputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'virtualReturns' :
                                for (const element of self.objectsTemplate.virtualReturns) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'expansionInputs' :
                                for (const element of self.objectsTemplate.expansionInputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                        }
                        // now the mixpoints are created
                        for (const outType of Object.keys(self.devices[self.config.device].out)) {
                            for (let j = 1; j <= self.devices[self.config.device].out[outType].amount; j++) {
                                if (i === j && outType === 'virtualSendBus') {
                                    continue;       // these points cannot be set
                                }
                                const actMixPoint = actInput + '.mixPoints.' + self.devices[self.config.device].out[outType].short + ('00' + j.toString()).slice(-2);
                                await self.setObjectNotExistsAsync(actMixPoint, {
                                    'type': 'folder',
                                    'common': {
                                        'role': 'mixpoint',
                                        'name': `Mixpoint ${outType} number ${j}`
                                    },
                                    'native': {}
                                });
                                for (const element of self.objectsTemplate.mixPoints) {
                                    await self.setObjectNotExistsAsync(actMixPoint + '.' + element._id, element);
                                }
                            }
                        }
                    }
                }
            }
            if (self.devices[self.config.device] && self.devices[self.config.device].ply) {
                // at this point the device has players
                await self.setObjectNotExistsAsync('ply', {
                    'type': 'folder',
                    'common': {
                        'name': 'All players'
                    },
                    'native': {}
                });
                for (const players of Object.keys(self.devices[self.config.device].ply)) {
                    // create player folder, key name is the folder id
                    await self.setObjectNotExistsAsync(`ply.${players}`, {
                        'type': 'folder',
                        'common': {
                            'name': self.devices[self.config.device].ply[players].name
                        },
                        'native': {}
                    });
                    // create the amount of players
                    for (let i = 1; i <= self.devices[self.config.device].ply[players].amount; i++) {
                        const actPlayer = `ply.${players}.${i}`;
                        // create the player folder
                        await self.setObjectNotExistsAsync(actPlayer, self.objectsTemplate.player);
                        // and the common structure of a player
                        for (const element of self.objectsTemplate.players) {
                            await self.setObjectNotExistsAsync(actPlayer + '.' + element._id, element);
                        }
                    }
                }
            }
            if (self.devices[self.config.device] && self.devices[self.config.device].out) {
                // at this point the device has outputs
                await self.setObjectNotExistsAsync('out', {
                    'type': 'folder',
                    'common': {
                        'name': 'All outputs'
                    },
                    'native': {}
                });
                for (const outputs of Object.keys(self.devices[self.config.device].out)) {
                    // create outputs folder, key name is the folder id
                    await self.setObjectNotExistsAsync(`out.${outputs}`, {
                        'type': 'folder',
                        'common': {
                            'name': self.devices[self.config.device].out[outputs].name
                        },
                        'native': {}
                    });
                    // create the amount of outputs
                    for (let i = 1; i <= self.devices[self.config.device].out[outputs].amount; i++) {
                        const actOutput = `out.${outputs}.${('00' + i.toString()).slice(-2)}`;
                        // create the output folder
                        await self.setObjectNotExistsAsync(actOutput, self.objectsTemplate.output);
                        // and the common structure of a output
                        switch (outputs) {

                            case 'outputs' :
                                for (const element of self.objectsTemplate.outputs) {
                                    await self.setObjectNotExistsAsync(actOutput + '.' + element._id, element);
                                }
                                break;

                            case 'auxOutputs' :
                                for (const element of self.objectsTemplate.auxOutputs) {
                                    await self.setObjectNotExistsAsync(actOutput + '.' + element._id, element);
                                }
                                break;

                            case 'expansionOutputs' :
                                for (const element of self.objectsTemplate.expansionOutputs) {
                                    await self.setObjectNotExistsAsync(actOutput + '.' + element._id, element);
                                }
                                break;

                        }
                    }
                }
            }
        } catch (err) {
            self.errorHandler(err, 'createDatabase');
        }
    }
    /**
     * called to create a list of all states in the database
     */
    async createStatesListAsync(){
        const self = this;
        self.stateList = Object.keys(await self.getStatesAsync('*'));
    }
    /**
     * called to get all database item status from device
     */
    getDeviceStatus() {
        const self = this;
        try {
            // if status has not been requested
            if (!self.statusRequested && self.isVerboseMode) {
                self.log.info('Extron get device status started');
                // iterate through stateList to request status from device
                for (let index = 0; index < self.stateList.length; index++) {
                    const id = self.stateList[index];
                    const baseId = id.substr(0, id.lastIndexOf('.'));
                    const stateName = id.substr(id.lastIndexOf('.') + 1);

                    if (typeof(baseId) !== 'undefined' && baseId !== null) {
                        // @ts-ignore
                        switch (stateName) {
                            case 'mute' :
                                self.getMuteStatus(id);
                                break;

                            case 'source' :
                                self.getSource(id);
                                break;

                            case 'level' :
                                self.getGainLevel(id);
                                break;

                            case 'playmode' :
                                self.getPlayMode(id);
                                break;

                            case 'repeatmode' :
                                self.getRepeatMode(id);
                                break;

                            case 'filename' :
                                self.getFileName(id);
                                break;
                        }
                    }
                }
                self.statusRequested = true;
                self.log.info('Extron get device status completed');
            }
        } catch (err) {
            self.errorHandler(err, 'getDeviceStatus');
        }
    }
    /**
     * calculate linValue -> logValue -> devValue and back
     * @param {number | string | undefined} value
     * @param {string} type
     * Type of value provided:
     * dev,  lin, log (-1000 .. 120, 0 .. 1000, -100 .. 12)
     * devGain, linGain, logGain (-180 .. 800, 0 .. 1000, -18 .. 80)
     * devAux, linAux, logAux (-180 .. 240, 0.. 1000, -18 .. 24)
     * devTrim, linTrim, logTrim (-120 .. 120, 0 .. 1000, -12 .. 12)
     * devAtt, linAtt, logAtt (-1000 .. 0, 0 .. 1000, -100 .. 0)
     * returns: Object with all 3 value types
     */
    calculateFaderValue(value, type) {
        const self = this;
        const locObj = {};

        try {
            if (typeof value === 'undefined') return {};
            if (typeof value === 'string') value = Number(value);

            switch (type) {

                case 'lin':        // linear value 0 .. 1000 from database
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);

                    if (value === 764) {
                        locObj.logValue = '0.0';
                        locObj.devValue = '0';
                    } else if (value > 764) {
                        locObj.logValue = (((value - 764) / 236) * 12).toFixed(1);
                        locObj.devValue = (((value - 764) / 236) * 120).toFixed(0);
                    } else {        // 0 .. 764
                        locObj.logValue = (((764 - value) / 764) * -100).toFixed(1);
                        locObj.devValue = (((764 - value) / 764) * -1000).toFixed(0);
                    }
                    break;

                case 'log':        // value from database -100.0 .. 12.0
                case 'dev':        // value from device -1000 .. 120
                    if (type === 'log') value = value * 10;
                    value = value > 120 ? 120 : value;
                    value = value < -1000 ? -1000 : value;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = value.toFixed(0);

                    //value = value * 10;
                    if (value < 0) {
                        locObj.linValue = (((value + 1000) * 764) / 1000).toFixed(0);
                    } else {
                        locObj.linValue = (((value * 236) / 120) + 764).toFixed(0);
                    }
                    break;

                case 'linGain':      // linear value from database 0 .. 1000 for Input
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 980 / 1000) - 180).toFixed(0);
                    locObj.logValue = ((value * 98 / 1000) - 18).toFixed(1);
                    break;

                case 'logGain':      // value from database -18.0 .. 80.0 for input
                case 'devGain':      // value from device -180 .. 800 for input
                    value = value > 800 ? 800 : value;
                    value = value < -180 ? -180 : value;
                    if (type === 'logGain') value = value * 10;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = (value).toFixed(0);
                    locObj.linValue = ((value + 180) * 1000 / 980).toFixed(0);
                    break;

                case 'linAux':   //linear value from database 0 .. 1000 for AuxInput
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 420 / 1000) - 180).toFixed(0);
                    locObj.logValue = ((value * 42 / 1000) - 18).toFixed(1);
                    break;

                case 'logAux':      // value from database -18.0 .. 24.0 for input
                case 'devAux':      // value from device -180 .. 240 for input
                    value = value > 240 ? 240 : value;
                    value = value < -180 ? -180 : value;
                    if (type === 'logAux') value = value * 10;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = (value).toFixed(0);
                    locObj.linValue = ((value + 180) * 1000 / 420).toFixed(0);
                    break;

                case 'logTrim' :       // value from database -12.0 .. 12.0 for PostMix Trim
                case 'devTrim' :       // value from device -120 .. 120 for PostMix Trim
                    value = value > 120 ? 120 : value;
                    value = value < -120 ? -120 : value;
                    if (type === 'logTrim') value = value * 10;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = (value).toFixed(0);
                    locObj.linValue = ((value + 120) * 1000 / 240).toFixed(0);
                    break;

                case 'linTrim' :       // linear value from database 0 ..1000 for PostMix Trim
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = ((value * 240 / 1000) - 120).toFixed(0);
                    locObj.logValue = ((value * 24 / 1000) - 12).toFixed(1);
                    break;

                case 'logAtt' :        // value from database -100 .. 0 for output attenuation
                case 'devAtt' :        //  value from device -1000 .. 0 for output attenuation
                    value = value > 0 ? 0 : value;
                    value = value < -1000 ? -1000 : value;
                    if (type === 'logAtt') value = value * 10;

                    locObj.logValue = (value / 10).toFixed(1);
                    locObj.devValue = (value).toFixed(0);
                    locObj.linValue = (value + 1000).toFixed(0);
                    break;

                case 'linAtt' :        // value from database 0 .. 1000 for output attenuation
                    value = value > 1000 ? 1000 : value;
                    value = value < 0 ? 0 : value;

                    locObj.linValue = value.toFixed(0);
                    locObj.devValue = (value - 1000).toFixed(0);
                    locObj.logValue = ((value / 10) - 100).toFixed(1);
                    break;

            }
        } catch (err) {
            self.errorHandler(err, 'calculateFaderValue');
        }

        return locObj;
    }
    /** BEGIN Input and Mix control */
    /**
     * Set the database values for a mixpoint or channel
     * @param {string} cmd
     * @param {string} oid
     * @param {string | boolean} value
     * cmd = DSM (mute), DSG (gain)
     */
    setGain(cmd, oid, value) {
        const self = this;
        try {
            const mixPoint = self.oid2id(oid);
            const idArray = mixPoint.split('.');
            const idType = idArray[1];
            const idBlock = idArray[3];
            let calcMode ='dev';
            if (cmd === 'DSM') {
                self.setState(`${mixPoint}mute`, value === '1' ? true : false, true);
            } else {
                switch (idBlock) {
                    case 'gain' :
                        calcMode = 'devGain';
                        if (idType === 'auxInputs') calcMode = 'devAux';
                        break;

                    case 'postmix' :
                        calcMode = 'devTrim';
                        break;

                    case 'attenuation' :
                        calcMode = 'devAtt';
                        break;
                }

                const faderVal = self.calculateFaderValue(value.toString(), calcMode);
                if (faderVal) {
                    self.setState(`${mixPoint}level_db`, faderVal.logValue, true);
                    self.setState(`${mixPoint}level`, faderVal.linValue, true);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'setGain');
        }
    }
    /**
     * Send the mute status to the device
     * @param {string} baseId
     * @param {string | any} value
     */
    sendMuteStatus(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WM${oid}*${value ? '1' : '0'}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendMuteStatus');
        }
    }
    /**
     * request the mute status from device
     * @param {string} baseId
     */
    getMuteStatus(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WM${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getMuteStatus');
        }
    }
    /**
     * Send the gain level to the device
     * @param {string} baseId
     * @param {string | any} value
     */
    sendGainLevel(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                const sendData = `WG${oid}*${value.devValue}AU\r`;
                self.streamSend(sendData);
            }
        } catch (err) {
            this.errorHandler(err, 'sendGainLevel');
        }
    }
    /**
     * get the gain level from device
     * @param {string} baseId
     */
    getGainLevel(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WG${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendGainLevel');
        }
    }
    /**
     * Set the source for a auxinput
     * @param {string} oid
     * @param {string | number} value
     * cmd = DSD (source)
     */
    setSource(oid, value) {
        const self = this;
        try {
            const channel = self.oid2id(oid);
            self.setState(`${channel}source`, value, true);
        } catch (err) {
            this.errorHandler(err, 'setSource');
        }
    }
    /**
     * Send the source mode to the device
     * @param {string} baseId
     * @param {string | number} value
     */
    sendSource(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(`${baseId}.source`);
            if (oid) {
                self.streamSend(`WD${oid}*${value}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendSource');
        }
    }
    /**
     * get the source mode from device
     * @param {string} baseId
     */
    getSource(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(`${baseId}.source`);
            if (oid) {
                self.streamSend(`WD${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getSource');
        }
    }
    /** END Input and Mix control */
    /** BEGIN integrated audio player control */
    /**
     * Set the database values for a player
     * @param {string} oid
     * @param {string | boolean} value
     * cmd = PLAY (playmode)
     */
    setPlayMode(oid, value) {
        const self = this;
        try {
            const player = self.oid2id(oid);
            self.setState(`${player}playmode`, value === '1' ? true : false, true);
        } catch (err) {
            this.errorHandler(err, 'setPlayMode');
        }
    }
    /**
     * control playback on the device.player
     * @param {string} baseId
     * @param {string | any} value
     */
    sendPlayMode(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`W${oid}*${(value?'1':'0')}PLAY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendPlayMode');
        }
    }
    /**
     * request playback mode from the device.player
     * @param {string}  baseId
     * cmd = PLAY
     */
    getPlayMode(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`W${oid}PLAY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getPlayMode');
        }
    }
    /**
     * Set the database values for a player
     * @param {string} oid
     * @param {string | boolean} value
     * cmd = CPLYM (repeatmode)
     */
    setRepeatMode(oid, value) {
        const self = this;
        try {
            const player = self.oid2id(oid);
            self.setState(`${player}repeatmode`, value === '1' ? true : false, true);
        } catch (err) {
            this.errorHandler(err, 'setRepeatMode');
        }
    }
    /**
     * control repeatmode on the device.player
     * @param {string} baseId
     * @param {string | any} value
     */
    sendRepeatMode(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WM${oid}*${(value?'1':'0')}CPLY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendPlayMode');
        }
    }
    /**
     * request repeatmode on the device.player
     * @param {string} baseId
     * cmd = CPLY
     */
    getRepeatMode(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WM${oid}CPLY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendPlayMode');
        }
    }
    /**
     * Send the Player filename to device
     * @param {string} baseId
     * @param {string | boolean} value
     */
    sendFileName(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WA${oid}*${value}CPLY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendFileName');
        }
    }
    /**
     * Send clear Player filename to device
     * @param {string} baseId
     * cmd = CPLY
     */
    clearFileName(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WA${oid}* CPLY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendFileName');
        }
    }
    /**
     * Set the Player filename in the database
     * @param {string} oid
     * @param {string} value
     * cmd = CPLYA (associate file to player)
     */
    setFileName(oid, value) {
        const self = this;
        try {
            const player = self.oid2id(oid);
            self.setState(`${player}filename`, value, true);
        } catch (err) {
            this.errorHandler(err, 'setFileName');
        }
    }
    /**
     * request current filename from player
     * @param {string} baseId
     * cmd = CPLY
     */
    getFileName(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WA${oid}CPLY\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendFileName');
        }
    }
    /** END integrated audio player control */
    /**
     * determine the database id from oid e.g. 20002 -> in.inputs.01.mixPoints.O03
     * @param {string} oid
     * returns: String with complete base id to mixPoint or the gainBlock
     */
    oid2id(oid) {
        const self = this;
        let retId = '';
        try {
            if (Number(oid) < 9) {
                retId = `ply.players.${Number(oid)}.common.`;
            }
            else {
                const what = Number(oid.substr(0,1));
                const where = Number(oid.substr(1,2));
                const val = Number(oid.substr(3,2));
                switch (what) {
                    case 2:                         // mixpoints
                        if (where <= 11) {          // from input 1 - 12
                            retId = `in.inputs.${('00' + (where + 1).toString()).slice(-2)}.mixPoints.`;
                        } else if (where <= 19) {   // aux input 1 - 8
                            retId = `in.auxInputs.${('00' + (where - 11).toString()).slice(-2)}.mixPoints.`;
                        } else if (where <= 35) {   // virtual return 1 - 16 (A-P)
                            retId = `in.virtualReturns.${('00' + (where - 19).toString()).slice(-2)}.mixPoints.`;
                        } else if (where <= 83) {   // AT input 1 - 48
                            retId = `in.expansionInputs.${('00' + (where - 35).toString()).slice(-2)}.mixPoints.`;
                        } else {
                            throw { 'message': 'no known mixpoint input',
                                'stack'  : `oid: ${oid}` };
                        }
                        // now determine the output
                        if (val <= 7) {             // output 1 -8
                            retId += `O${('00' + (val + 1).toString()).slice(-2)}.`;
                        } else if (val <= 15) {     // aux output 1 - 8
                            retId += `A${('00' + (val - 7).toString()).slice(-2)}.`;
                        } else if (val <= 31) {     // virtual send bus 1 - 16
                            retId += `V${('00' + (val - 15).toString()).slice(-2)}.`;
                        } else if (val <= 47) {     // expansion output 1 - 16
                            retId += `E${('00' + (val - 31).toString()).slice(-2)}.`;
                        } else {
                            throw { 'message': 'no known mixpoint output',
                                'stack'  : `oid: ${oid}` };
                        }
                        break;

                    case 4:                         // input block
                        if (where === 0) {          // Input gain block
                            if (val <= 11) {        // input 1 - 12
                                return `in.inputs.${('00' + (val + 1).toString()).slice(-2)}.gain.`;
                            }
                            if (val <= 19) {        // aux input 1 - 8
                                return `in.auxInputs.${('00' + (val - 11).toString()).slice(-2)}.gain.`;
                            }
                        } else if (where === 1) {   // premix gain block
                            if (val <= 11) {        // input 1 - 12
                                return `in.inputs.${('00' + (val + 1).toString()).slice(-2)}.premix.`;
                            }
                            if (val <= 19) {        // aux input 1 - 8
                                return `in.auxInputs.${('00' + (val - 11).toString()).slice(-2)}.premix.`;
                            }
                        }
                        throw { 'message': 'no known input',
                            'stack'  : `oid: ${oid}` };

                    case 5:                         // virtual return and ext input
                        if (where === 1) {          // virtual returns
                            if (val <= 15) {        // virtual return 1 - 16 (A-P)
                                return `in.virtualReturns.${('00' + (val + 1).toString()).slice(-2)}.premix.`;
                            }
                        }
                        if (where === 2) {          // expansion bus (AT inputs)
                            if (val <= 47) {        // AT input 1 - 48
                                return `in.expansionInputs.${('00' + (val + 1).toString()).slice(-2)}.premix.`;
                            }
                        }
                        throw { 'message': 'no known input',
                            'stack'  : `oid: ${oid}` };

                    case 6:                         // Output section
                        if (where === 0) {          // Output attenuation block
                            if (val <= 7) {         // output 1 - 8
                                return `out.outputs.${('00' + (val + 1).toString()).slice(-2)}.attenuation.`;
                            }
                            if (val <= 15) {        // aux output 1 - 8
                                return `out.auxOutputs.${('00' + (val - 7).toString()).slice(-2)}.attenuation.`;
                            }
                            if (val <= 31) {        // expansion output 1-16
                                return `out.expansionOutputs.${('00' + (val - 15).toString()).slice(-2)}.attenuation.`;
                            }
                        }
                        if (where === 1) {          // postmix trim block
                            if (val <= 7) {         // output 1 - 8
                                return `out.outputs.${('00' + (val + 1).toString()).slice(-2)}.postmix.`;
                            }
                            if (val <= 15) {        // aux output 1 - 8
                                return `out.auxOutputs.${('00' + (val - 7).toString()).slice(-2)}.postmix.`;
                            }
                            if (val <= 31) {        // expansion output 1-16
                                return `out.expansionOutputs.${('00' + (val - 15).toString()).slice(-2)}.postmix.`;
                            }
                        }
                        throw { 'message': 'no known output',
                            'stack'  : `oid: ${oid}` };

                    default:
                        throw { 'message': 'unknown OID',
                            'stack'  : `oid: ${oid}` };
                }
            }
        } catch (err) {
            self.errorHandler(err, 'oid2id');
            return '';
        }
        return retId;
    }
    /**
     * determine the oid from the database id e.g. in.inputs.01.mixPoints.O03 -> 20002
     * @param {string} id
     * returns: String with complete base id to mixPoint or the gainBlock
     */
    id2oid(id) {
        const self = this;
        let retOid = '';
        try {
            const idArray = id.split('.');
            const idType = idArray[3];
            const idNumber = Number(idArray[4]);
            const idBlock = idArray[5];
            let outputType = 'O';
            let outputNumber = 1;
            if (idArray.length >= 7) {
                outputType = idArray[6].substr(0,1);
                outputNumber = Number(idArray[6].substr(1,2));
            }
            if (idType === 'players') {
                retOid = idNumber.toString();
            }
            else
            {
                if (idBlock != 'mixPoints') {     // inputs / outputs
                    switch (idType) {
                        case 'inputs':
                            if (idBlock === 'gain') {
                                retOid = `400${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            } else {
                                retOid = `401${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            }
                            break;

                        case 'auxInputs':
                            if (idBlock === 'gain') {
                                retOid = `400${('00' + (idNumber + 11).toString()).slice(-2)}`;
                            } else {
                                retOid = `401${('00' + (idNumber + 11).toString()).slice(-2)}`;
                            }
                            break;

                        case 'virtualReturns':
                            retOid = `501${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            break;

                        case 'expansionInputs':
                            retOid = `502${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            break;

                        case 'outputs' :
                            if (idBlock === 'attenuation') {
                                retOid = `600${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            } else {
                                retOid = `601${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            }
                            break;

                        case 'auxOutputs' :
                            if (idBlock === 'attenuation') {
                                retOid = `600${('00' + (idNumber + 7).toString()).slice(-2)}`;
                            } else {
                                retOid = `601${('00' + (idNumber + 7).toString()).slice(-2)}`;
                            }
                            break;

                        case 'expansionOutputs' :
                            if (idBlock === 'attenuation') {
                                retOid = `600${('00' + (idNumber + 15).toString()).slice(-2)}`;
                            } else {
                                retOid = `601${('00' + (idNumber + 15).toString()).slice(-2)}`;
                            }
                            break;

                        default:
                            retOid = '';
                    }
                }   else
                {                      // mixpoints
                    switch (idType) {
                        case 'inputs':
                            retOid = `2${('00' + (idNumber -1).toString()).slice(-2)}`;
                            break;

                        case 'auxInputs':
                            retOid = `2${('00' + (idNumber + 11).toString()).slice(-2)}`;
                            break;

                        case 'virtualReturns':
                            retOid = `2${('00' + (idNumber + 19).toString()).slice(-2)}`;
                            break;

                        case 'expansionInputs':
                            retOid = `2${('00' + (idNumber + 35).toString()).slice(-2)}`;
                            break;

                        default:
                            retOid = '';
                    }
                    switch (outputType) {
                        case 'O':
                            retOid += ('00' + (outputNumber - 1).toString()).slice(-2);
                            break;

                        case 'A':
                            retOid += ('00' + (outputNumber + 7).toString()).slice(-2);
                            break;

                        case 'V':
                            retOid += ('00' + (outputNumber + 15).toString()).slice(-2);
                            break;

                        case 'E':
                            retOid += ('00' + (outputNumber + 31).toString()).slice(-2);
                            break;
                        case 's':
                            break;

                        default:
                                // retOid = '';
                    }
                }
            }
        } catch (err) {
            self.errorHandler(err, 'id2oid');
            return '';
        }
        return retOid;
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearTimeout(timeout2);
            // ...
            clearInterval(this.timers.intervallQueryStatus);

            // close client connection
            this.client.end();

            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        const self = this;
        try {
            if (state) {
                // The state was changed
                // self.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                if (!state.ack) {       // only react on not acknowledged state changes
                    self.log.info(`Extron state ${id} changed: ${state.val} (ack = ${state.ack})`);
                    if (!state.val) state.val = '';
                    const baseId = id.substr(0, id.lastIndexOf('.'));
                    const idArray = id.split('.');
                    const idType = idArray[3];
                    const idBlock = idArray[5];
                    const stateName = id.substr(id.lastIndexOf('.') + 1);
                    let calcMode ='lin';
                    if (typeof(baseId) !== 'undefined' && baseId !== null) {
                        // @ts-ignore
                        switch (stateName) {
                            case 'mute' :
                                self.sendMuteStatus(id, state.val);
                                break;
                            case 'source' :
                                self.sendSource(id, state.val.toString());
                                break;
                            case 'level' :
                                switch (idBlock) {
                                    case 'gain' :
                                        calcMode = 'linGain';
                                        if (idType === 'auxInputs') calcMode = 'linAux';
                                        break;

                                    case 'postmix' :
                                        calcMode = 'linTrim';
                                        break;

                                    case 'attenuation' :
                                        calcMode = 'linAtt';
                                        break;
                                }
                                self.sendGainLevel(id,self.calculateFaderValue(state.val.toString(),calcMode));
                                break;
                            case 'level_db' :
                                calcMode ='log';
                                switch (idBlock) {
                                    case 'gain' :
                                        calcMode = 'logGain';
                                        if (idType === 'auxInputs') calcMode = 'logAux';
                                        break;

                                    case 'postmix' :
                                        calcMode = 'logTrim';
                                        break;

                                    case 'attenuation' :
                                        calcMode = 'logAtt';
                                        break;
                                }
                                self.sendGainLevel(id,self.calculateFaderValue(state.val.toString(),calcMode));
                                break;

                            case 'playmode' :
                                self.sendPlayMode(id, state.val);
                                break;

                            case 'repeatmode' :
                                self.sendRepeatMode(id, state.val);
                                break;

                            case 'filename' :
                                self.sendFileName(id, state.val.toString());
                                break;
                        }
                    }
                }
            } else {
                // The state was deleted
                self.log.info(`Extron state ${id} deleted`);
            }
        } catch (err) {
            self.errorHandler(err, 'onStateChange');
        }
    }

    /**
     * Called on error situations and from catch blocks
	 * @param {Error} err
	 * @param {string} module
	 */
    errorHandler(err, module = '') {
        let errorStack = err.stack;
        //        if (err.stack) errorStack = err.stack.replace(/\n/g, '<br>');
        if (err.name === 'ResponseError') {     // gerade nicht benötigt, template ....
            if (err.message.includes('Permission denied') || err.message.includes('Keine Berechtigung')) {
                this.log.error(`Permisson denied. Check the permission rights of your user on your device!`);
            }
            this.log.error(`Extron error in method: [${module}] response error: ${err.message.replace(module, '')}, stack: ${errorStack}`);
        } else {
            if (module === 'onClientError') {
                if (err.level === 'client-socket') {
                    this.log.error(`Extron error in ssh client (sockel level): ${err.message}, stack: ${errorStack}`);
                } else if (err.level === 'client-ssh') {
                    this.log.error(`Extron error in ssh client (ssh): ${err.message}, stack: ${errorStack}, description: ${err.description}`);
                } else {
                    this.log.error(`Extron error in ssh client (unknown): ${err.message}, stack: ${errorStack}`);
                }
            } else {
                this.log.error(`Extron error in method: [${module}] error: ${err.message}, stack: ${errorStack}`);
            }
        }
    }

    // If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
    // /**
    //  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
    //  * Using this method requires "common.message" property to be set to true in io-package.json
    //  * @param {ioBroker.Message} obj
    //  */
    // onMessage(obj) {
    //     if (typeof obj === 'object' && obj.message) {
    //         if (obj.command === 'send') {
    //             // e.g. send email or pushover or whatever
    //             this.log.info('send command');

    //             // Send response in callback if required
    //             if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
    //         }
    //     }
    // }


}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */

    module.exports = (options) => {'use strict'; new Extron(options); };
} else {
    // otherwise start the instance directly
    new Extron();
}