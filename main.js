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
            this.objectsTemplate = JSON.parse(fs.readFileSync(__dirname + '/lib/objects_templates.json', 'utf8'));
            // read devices for device check
            this.devices = JSON.parse(fs.readFileSync(__dirname + '/lib/device_mapping.json', 'utf8'));

            /*
            * For every state in the system there has to be also an object of type state
            */
            await self.createDatabaseAsync();

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
            self.log.info('Extron is autenticated successfully, now open the stream');
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
                self.log.silly('Extron push data to the send buffer: "' + self.decodeBufferToLog(data) + '"');
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
                        case 'DSG':             // received a gain gain
                            self.log.silly(`Extron got mute/gain ${command} from OID: "${ext1}" value: ${ext2}`);
                            self.setGainBlock(command, ext1, ext2);
                            break;
                    }
                } else {
                    self.log.silly('Extron received data which cannot be handled "' + answer + '"');
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
                        // and the common structure of an input
                        for (const element of self.objectsTemplate.inputs) {
                            await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
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
        } catch (err) {
            self.errorHandler(err, 'createDatabase');
        }
    }
    /**
     * calculate linValue -> logValue -> devValue and back
     * @param {number | string | undefined} value
     * @param {string} type         Type of value provided
     * devValue, linValue, logValue
     * returns: Object with all 3 value types
     */
    calculateFaderValue(value, type = 'devValue') {
        const self = this;
        const locObj = {};

        try {
            if (typeof value === 'undefined') return {};
            if (typeof value === 'string') value = Number(value);

            switch (type) {

                case 'linValue':        // linear value 0 .. 1000 from database
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

                case 'logValue':        // value from database -100.0 .. 12.0
                case 'devValue':        // value from device -1000 .. 120
                    if (type === 'logValue') value = value * 10;
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


            }
        } catch (err) {
            self.errorHandler(err, 'calculateFaderValue');
        }

        return locObj;
    }
    /**
     * Set the database values for a mixpoint or channel
     * @param {string} cmd
     * @param {string} oid
     * @param {string | boolean} value
     * cmd = DSM (mute), DSG (gain)
     */
    setGainBlock(cmd, oid, value) {
        const self = this;
        try {
            const mixPoint = self.oid2id(oid);
            if (cmd === 'DSM') {
                self.setState(`${mixPoint}.mute`, value === '1' ? true : false, true);
            } else {
                const faderVal = self.calculateFaderValue(value.toString(), 'devValue');
                if (faderVal) {
                    self.setState(`${mixPoint}.level_db`, faderVal.logValue, true);
                    self.setState(`${mixPoint}.level`, faderVal.linValue, true);
                }
            }
        } catch (err) {
            this.errorHandler(err, 'setMixpoint');
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
     * Send the gain level to the device
     * @param {string} baseId
     * @param {string | any} value
     */
    sendGainLevel(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WG${oid}*${value.devValue}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendGainLevel');
        }
    }
    /**
     * determine the database id from oid e.g. 20002 -> in.inputs.01.mixPoints.O03
     * @param {string} oid
     * returns: String with complete base id to mixPoint or the gainBlock
     */
    oid2id(oid) {
        const self = this;
        let retId = '';
        try {
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
                        retId = `in.expansionBus.${('00' + (where - 35).toString()).slice(-2)}.mixPoints.`;
                    } else {
                        throw { 'message': 'no known input',
                            'stack'  : `oid: ${oid}` };
                    }
                    // now determine the output
                    if (val <= 7) {             // output 1 -8
                        retId += `O${('00' + (val + 1).toString()).slice(-2)}`;
                    } else if (val <= 15) {     // aux output 1 - 8
                        retId += `A${('00' + (val - 7).toString()).slice(-2)}`;
                    } else if (val <= 31) {     // virtual send bus 1 - 16
                        retId += `V${('00' + (val - 15).toString()).slice(-2)}`;
                    } else if (val <= 47) {     // expansion output 1 - 16
                        retId += `E${('00' + (val - 31).toString()).slice(-2)}`;
                    }
                    break;

                case 4:                         // input block
                    if (where === 1) {          // premix gain block
                        if (val <= 11) {        // input 1 - 12
                            return `in.inputs.${('00' + (val + 1).toString()).slice(-2)}.common`;
                        }
                        if (val <= 19) {        // aux input 1 - 8
                            return `in.auxInputs.${('00' + (val - 11).toString()).slice(-2)}.common`;
                        }
                    }
                    throw { 'message': 'no known input',
                        'stack'  : `oid: ${oid}` };

                case 5:                         // virtual return and ext input
                    if (where === 1) {          // virtual return
                        if (val <= 15) {        // virtual return 1 - 16 (A-P)
                            return `in.virtualReturns.${('00' + (val + 1).toString()).slice(-2)}.common`;
                        }
                    }
                    if (where === 2) {          // expansion bus (AT inputs)
                        if (val <= 47) {        // AT input 1 - 48
                            return `in.expansionBus.${('00' + (val + 1).toString()).slice(-2)}.common`;
                        }
                    }
                    throw { 'message': 'no known input',
                        'stack'  : `oid: ${oid}` };

                default:
                    throw { 'message': 'no known input',
                        'stack'  : `oid: ${oid}` };
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
            const inputType = idArray[3];
            const inputNumber = Number(idArray[4]);
            let outputType = 'O';
            let outputNumber = 1;
            if (idArray.length >= 7) {
                outputType = idArray[6].substr(0,1);
                outputNumber = Number(idArray[6].substr(1,2));
            }
            switch (idArray.length) {
                case 6:     // input
                    switch (inputType) {
                        case 'inputs':
                            retOid = `401${('00' + (inputNumber - 1).toString()).slice(-2)}`;
                            break;

                        case 'auxInputs':
                            retOid = `401${('00' + (inputNumber + 11).toString()).slice(-2)}`;
                            break;

                        case 'virtualReturns':
                            retOid = `501${('00' + (inputNumber - 1).toString()).slice(-2)}`;
                            break;

                        case 'expansionBus':
                            retOid = `502${('00' + (inputNumber - 1).toString()).slice(-2)}`;
                            break;

                        default:
                            retOid = '';
                    }
                    break;

                case 7:     // mixpoint
                    switch (inputType) {
                        case 'inputs':
                            retOid = `2${('00' + (inputNumber - 1).toString()).slice(-2)}`;
                            break;

                        case 'auxInputs':
                            retOid = `2${('00' + (inputNumber + 11).toString()).slice(-2)}`;
                            break;

                        case 'virtualReturns':
                            retOid = `2${('00' + (inputNumber + 19).toString()).slice(-2)}`;
                            break;

                        case 'expansionBus':
                            retOid = `2${('00' + (inputNumber + 35).toString()).slice(-2)}`;
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

                        default:
                            retOid = '';
                    }
                    break;

                default:
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
                    const stateName = id.substr(id.lastIndexOf('.') + 1);
                    const locObj = await this.getObjectAsync(baseId);
                    if (typeof(baseId) !== 'undefined' && baseId !== null) {
                        // @ts-ignore
                        const locRole = typeof(locObj.common.role) !== 'undefined' ? locObj.common.role : '';
                        switch (locRole) {
                            case 'input.channel':
                                if (stateName === 'mute') self.sendMuteStatus(baseId, state.val);
                                break;

                            case 'mixpoint':
                                if (stateName === 'mute') self.sendMuteStatus(baseId, state.val);
                                if (stateName === 'level') self.sendGainLevel(baseId, self.calculateFaderValue(state.val.toString(), 'linValue'));
                                if (stateName === 'level_db') self.sendGainLevel(baseId, self.calculateFaderValue(state.val.toString(), 'logValue'));
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
        const errorStack = err.stack;
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