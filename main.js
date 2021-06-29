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
//const Telnet = require('telnet-cient');
// @ts-ignore
const path = require('path');

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
const maxPollCount = 10;


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
        this.statusRequested = false;       // will be true once device status has been requested after init
        this.statusSended = false;          // will be true once database settings have been sended to device
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
        this.stateList = [];            // will be filled with all existing states
        this.pollCount = 0;             // count sent status query
        this.playerLoaded = [false, false, false, false, false, false, false,false];    // remember which player has a file assigned
        this.auxOutEnabled = [false, false, false, false, false, false, false,false];   // remember which aux output is enabled
        this.fileSend = false;          // flag to signal a file is currently sended
        this.requestDir = false;        // flag to signal a list user files command has been issued and a directory list is to be received
        this.file = {'fileName' : '', 'timeStamp' : '', 'fileSize':''};         // file object
        this.fileList = {'freeSpace' : '', 'files' : [this.file]};              // array to hold current file list
        this.stateBuf = [{'id': '', 'timestamp' : 0}];
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
            this.timers.timeoutQueryStatus = setTimeout(self.extronQueryStatus.bind(self), self.config.pollDelay);

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
                // @ts-ignore
                'debug': self.debugSSH ? this.log.silly.bind(this) : undefined,
                //'debug': true,
                'readyTimeout': 5000,
                'tryKeyboard': true
            });
        } catch (err) {
            self.errorHandler(err, 'clientConnect');
        }
    }

    /**
     * reconnect CLient after error
     */
    clientReConnect() {
        const self = this;
        self.log.info('closing client');
        self.client.end();
        self.log.info(`reconnecting after ${self.config.reconnectDelay}ms`);
        self.timers.timeoutReconnectClient = setTimeout(self.clientConnect.bind(self),self.config.reconnectDelay);
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
            self.isDeviceChecked = false;       // will be true if device sends banner and will be verified
            self.isVerboseMode = false;         // will be true if verbose mode 3 is active
            self.initDone = false;              // will be true if all init is done
            self.versionSet = false;            // will be true if the version is once set in the db
            self.statusRequested = false;       // will be true if device status has been requested after init
            self.statusSended = false;          // will be true once database settings have been sended to device
            this.stream = undefined;
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
            self.clientReConnect();
        }
    }

    /**
     * called if stream receives data
     * @param {string | Uint8Array} data
     */
    async onStreamData(data) {
        const self = this;
        if (self.fileSend) return; // do nothing during file transmission
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
            if (self.requestDir) {              // directory file list expected
                self.requestDir = false;        // directory list has been received, clear flag
                self.fileList.freeSpace = '';   // clear free space to be filled with new value from list
                self.setUserFilesAsync(data);        // call subroutine to set database values
                return;
            }
            // iterate through multiple answers connected via [LF]
            for (const cmdPart of data.toString().split('\n')) {

                if (cmdPart.includes('3CV')) {
                    self.log.debug('Extron device switched to verbose mode 3');
                    self.isVerboseMode = true;
                    this.timers.timeoutQueryStatus.refresh();
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
                        //self.timers.intervallQueryStatus = setInterval(self.extronQueryStatus.bind(self), self.config.pollDelay);
                        this.timers.timeoutQueryStatus.refresh();
                        if (self.config.pushDeviceStatus === true) {
                            await self.setDeviceStatusAsync();
                        } else {
                            await self.getDeviceStatusAsync();
                            //self.log.info('Extron get device status diabled');
                        }
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

                    this.pollCount = 0;     // reset pollcounter as valid data has been received
                    this.timers.timeoutQueryStatus.refresh();   // refresh poll timer

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

                        case 'DSE' :            //received a limiter status change
                            self.log.silly(`Extron got a limiter status change from OID : "${ext1}" value: "-${ext2}"`);
                            self.setLimitStatus(ext1, ext2);
                            break;
                        case 'DST' :            //received a limiter threshold change
                            self.log.silly(`Extron got a limiter threshold change from OID : "${ext1}" value: "${ext2}"`);
                            self.setLimitThreshold(ext1, ext2);
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

                        case 'IN1':             // received a tie command from CrossPoint
                        case 'IN2':
                        case 'IN3':
                        case 'IN4':
                        case 'IN5':
                        case 'IN6':
                        case 'IN7':
                        case 'IN8':
                            self.log.silly(`Extron got tie command ${command} for output: ${ext2}`);
                            self.setTie(command, ext2);
                            break;

                        case 'LOUT':            // received a tie command for loop out
                            self.log.silly(`Extron got tie command input "${ext1}" to loop output`);
                            self.setState(`connections.3.tie`, Number(ext1), true);
                            break;

                        case 'VMT':             // received a video mute
                            self.log.silly(`Extron got video mute for output "${ext1}" value "${ext2}"`);
                            if (self.devices[self.config.device].short === 'sme211') self.setState(`connections.1.mute`, Number(ext1), true);
                            else self.setState(`connections.${ext1}.mute`, Number(ext2), true);
                            break;

                        case 'PLYRS' :          // received video playing
                            self.log.silly(`Extron got video playing for output "${ext1}" value "${ext2}"`);
                            self.setPlayVideo(`ply.players.${ext1}.common.`, 1);
                            break;
                        case'PLYRE' :           // received Video paused
                            self.log.silly(`Extron got video paused for output "${ext1}" value "${ext2}"`);
                            self.setPlayVideo(`ply.players.${ext1}.common.`, 2);
                            break;
                        case 'PLYRO' :          // received video stopped
                            self.log.silly(`Extron got video stopped for output "${ext1}" value "${ext2}"`);
                            self.setPlayVideo(`ply.players.${ext1}.common.`, 0);
                            break;
                        case 'PLYR1' :          // received loop state
                            self.log.silly(`Extron got video loop mode for output "${ext1}" value "${ext2}"`);
                            self.setLoopVideo(`ply.players.${ext1}.common.`,ext2);
                            break;
                        case 'PLYRU' :          // received video filepath
                            self.log.silly(`Extron got video video filepath for output "${ext1}" value "${ext2}"`);
                            self.setVideoFile(`ply.players.${ext1}.common.`,ext2);
                            break;
                        case 'PLYRY' :
                            self.log.silly(`Extron got video playmmode "${ext1}" value "${ext2}"`);
                            self.setPlayVideo(`ply.players.1.common.`,Number(ext1));
                            break;

                        case 'STRM' :
                            self.log.silly(`Extron got streammode "${ext1}" value "${ext2}"`);
                            self.setStreamMode(`ply.players.1.common.`,Number(ext1));
                            break;

                        case 'UPL' :
                            self.fileSend = false;   // reset file transmission flag
                            self.log.silly(`Extron got upload file confirmation command size: "${ext1}" name: "${ext2}"`);
                            self.log.silly(`Extron requesting current user file list`);
                            self.listUserFiles();
                            break;
                        case 'WDF' :
                            self.log.debug(`Extron got list directory command`);
                            self.requestDir = true;     // set directory transmission flag
                            break;
                        case 'W+UF' :
                            self.log.debug(`Extron got upload file command: ${ext1} ${ext2}`);
                            self.fileSend = true;   // set file transmission flag
                            break;
                    }
                } else {
                    if ((answer != 'Q') && (answer != '') && (self.fileSend === false) && !(answer.match(/\d\*\d\w+/)) && !(answer.match(/\d\w/))) {
                        self.log.debug('Extron received data which cannot be handled "' + cmdPart + '"');
                    }
                }
            }
        } catch (err) {
            self.errorHandler(err, 'onStreamData');
            // @ts-ignore
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
        this.log.info('Extron onSteamError is closing the stream');
        this.stream.close();
    }

    /**
     * called if stream is closed
     */
    onStreamClose() {
        const self = this;
        self.log.debug('onStreamClose clear query timer');
        this.clearTimeout(this.timers.timeoutQueryStatus); // stop the query timer
        try {
            self.log.info('Extron stream closed calling client.end()');
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
            if (!self.fileSend) {
                self.streamSend('Q');
                self.pollCount += 1;
            }
            if (self.pollCount > maxPollCount) {
                self.log.error('maxPollCount exceeded');
                self.pollCount = 0;
                self.clientReConnect();
            } else {
                self.timers.timeoutQueryStatus.refresh();
            }
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
            // if cp82 or sme211 : create video inputs and outputs
            if ((self.devices[self.config.device].short === 'cp82') || (self.devices[self.config.device].short === 'sme211')) {
                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].connections) {
                    await self.setObjectNotExistsAsync(element._id, element);
                }
            }
            // if we have a user filesystem on the device
            if (self.devices[self.config.device] && self.devices[self.config.device].fs) {
                await self.setObjectNotExistsAsync(self.objectsTemplate.userflash.filesystem._id, self.objectsTemplate.userflash.filesystem);
                await self.setObjectNotExistsAsync(self.objectsTemplate.userflash.directory._id, self.objectsTemplate.userflash.directory);
                await self.setObjectNotExistsAsync(self.objectsTemplate.userflash.upload._id, self.objectsTemplate.userflash.upload);
                await self.setObjectNotExistsAsync(self.objectsTemplate.userflash.freespace._id, self.objectsTemplate.userflash.freespace);
                await self.setObjectNotExistsAsync(self.objectsTemplate.userflash.file._id, self.objectsTemplate.userflash.file);
            }
            // if we have inputs on the device
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
                        await self.setObjectNotExistsAsync(actInput, self.objectsTemplate[self.devices[self.config.device].objects[1]].input);
                        // and the common structure of an input depending on type
                        switch (inputs) {

                            case 'inputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].inputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'lineInputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].lineInputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'playerInputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].playerInputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'programInputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].programInputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'videoInputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].videoInputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'auxInputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].auxInputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'virtualReturns' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].virtualReturns) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                            case 'expansionInputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].expansionInputs) {
                                    await self.setObjectNotExistsAsync(actInput + '.' + element._id, element);
                                }
                                break;

                        }
                        // now the mixpoints are created
                        if (self.devices[self.config.device] && self.devices[self.config.device].mp) {      // if we have mixpoints
                            if (inputs != 'videoInputs') {
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
                                        for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].mixPoints) {
                                            await self.setObjectNotExistsAsync(actMixPoint + '.' + element._id, element);
                                        }
                                    }
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
                        await self.setObjectNotExistsAsync(actPlayer, self.objectsTemplate[self.devices[self.config.device].objects[1]].player);
                        // and the common structure of a player
                        for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].players) {
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
                        await self.setObjectNotExistsAsync(actOutput, self.objectsTemplate[self.devices[self.config.device].objects[1]].output);
                        // and the common structure of a output
                        switch (outputs) {

                            case 'outputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].outputs) {
                                    await self.setObjectNotExistsAsync(actOutput + '.' + element._id, element);
                                }
                                break;

                            case 'auxOutputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].auxOutputs) {
                                    await self.setObjectNotExistsAsync(actOutput + '.' + element._id, element);
                                }
                                break;

                            case 'expansionOutputs' :
                                for (const element of self.objectsTemplate[self.devices[self.config.device].objects[1]].expansionOutputs) {
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
    async getDeviceStatusAsync() {
        const self = this;
        try {
            // if status has not been requested
            if (!self.statusRequested && self.isVerboseMode) {
                self.log.info('Extron request device status started');
                // iterate through stateList to request status from device
                for (let index = 0; index < self.stateList.length; index++) {
                    const id = self.stateList[index];
                    const baseId = id.substr(0, id.lastIndexOf('.'));
                    const stateName = id.substr(id.lastIndexOf('.') + 1);
                    const idArray = id.split('.');
                    const idType = idArray[2];

                    if (typeof(baseId) !== 'undefined' && baseId !== null) {
                        // @ts-ignore
                        switch (stateName) {
                            case 'mute' :
                                if (idType === 'connections') self.getVideoMute(id);
                                else self.getMuteStatus(id);
                                break;

                            case 'source' :
                                self.getSource(id);
                                break;

                            case 'level' :
                                self.getGainLevel(id);
                                break;

                            case 'playmode' :
                                if (self.devices[self.config.device].short === 'smd202') {
                                    self.getPlayVideo();
                                } else self.getPlayMode(id);
                                break;

                            case 'repeatmode' :
                                self.getRepeatMode(id);
                                break;

                            case 'filename' :
                                self.getFileName(id);
                                break;

                            case 'filepath' :
                                self.getVideoFile();
                                break;

                            case 'loopmode' :
                                self.getLoopVideo();
                                break;

                            case 'streammode' :
                                self.getStreamMode();
                                break;

                            case 'dir' :
                                self.listUserFiles();
                                break;
                        }
                    }
                }
                self.statusRequested = true;
                self.log.info('Extron request device status completed');
            }
        } catch (err) {
            self.errorHandler(err, 'getDeviceStatus');
        }
    }

    /**
     * called to set all database item states to device
     */
    async setDeviceStatusAsync() {
        const self = this;
        let value = {};
        try {
            // if status has not been requested
            if (!self.statusSended && self.isVerboseMode) {
                self.log.info('Extron set device status started');
                // iterate through stateList to send status to device
                for (let index = 0; index < self.stateList.length; index++) {
                    const id = self.stateList[index];
                    const baseId = id.substr(0, id.lastIndexOf('.'));
                    const idArray = id.split('.');
                    const idType = idArray[3];
                    const idBlock = idArray[5];
                    const stateName = id.substr(id.lastIndexOf('.') + 1);
                    let calcMode ='lin';

                    if (typeof(baseId) !== 'undefined' && baseId !== null) {
                        // @ts-ignore
                        const stateobj = await self.getStateAsync(id);
                        // @ts-ignore
                        const state = stateobj.val;
                        if (state !== null) switch (stateName) {
                            case 'mute' :
                                self.sendMuteStatus(baseId, state);
                                break;

                            case 'source' :
                                self.sendSource(id, Number(state));
                                break;

                            case 'level' :
                                switch (idBlock) {
                                    case 'gain' :
                                        calcMode = 'linGain';
                                        if (idType === 'auxInputs') calcMode = 'linAux';
                                        if (idType === 'lineInputs') calcMode = 'linAux';
                                        break;

                                    case 'postmix' :
                                        calcMode = 'linTrim';
                                        break;

                                    case 'attenuation' :
                                        calcMode = 'linAtt';
                                        break;
                                }
                                value = self.calculateFaderValue(Number(state),calcMode);
                                self.sendGainLevel(id,value);
                                break;

                            case 'playmode' :
                                self.sendPlayMode(baseId, state);
                                break;

                            case 'repeatmode' :
                                self.sendRepeatMode(baseId, state);
                                break;

                            case 'filename' :
                                self.sendFileName(baseId, state.toString());
                                self.playerLoaded[Number(self.id2oid(baseId))-1] = (state.toString() != '' ? true : false);
                                break;

                            case 'streammode' :
                                self.sendStreamMode(Number(state));
                                break;
                        }
                    }
                }
                self.statusSended = true;
                self.log.info('Extron set device status completed');
            }
        } catch (err) {
            self.errorHandler(err, 'setDeviceStatus');
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
                        if (self.devices[self.config.device].short === 'sme211') calcMode = 'devAux';
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
                    self.setState(`${mixPoint}level_db`, Number(faderVal.logValue), true);
                    self.setState(`${mixPoint}level`, Number(faderVal.linValue), true);
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
            let oid = self.id2oid(baseId);
            if (oid) {
                let sendData = `WG${oid}*${value.devValue}AU\r`;
                self.streamSend(sendData);
                if (self.devices[self.config.device].short === 'sme211') { // on SME211 we have stereo controls
                    switch (Number(oid)) {
                        case 40000 :
                            oid = '40001';
                            break;
                        case 40001 :
                            oid = '40000';
                            break;
                        case 40002 :
                            oid = '40003';
                            break;
                        case 40003 :
                            oid = '40002';
                            break;
                    }
                    sendData = `WG${oid}*${value.devValue}AU\r`;
                    self.streamSend(sendData);
                }
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
            self.setState(`${channel}source`, Number(value), true);
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
                self.streamSend(`WD${oid}*${value === '' ? 0: value}AU\r`);
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

    /**
     * get the input name from device
     * @param {string} baseId
     */
    getInputName(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(`${baseId}.name`);
            if (oid) {
                self.streamSend(`${oid}NI\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getInputName');
        }
    }

    /**
     * set limiter status in database
     * @param {string} oid
     * @param {string | number} value
     */
    setLimitStatus(oid, value) {
        const self = this;
        try {
            const channel = self.oid2id(oid);
            self.setState(`${channel}status`, Number(value), true);
        } catch (err) {
            this.errorHandler(err, 'setLimitStatus');
        }
    }

    /**
     * get limiter status
     * @param {string} baseId
     * cmd WE[oid]AU
     */
    getLimitStatus(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(`${baseId}.status`);
            if (oid) {
                self.streamSend(`WE${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getLimitStatus');
        }
    }

    /**
     * send Limiter status to device
     * @param {string} baseId
     * @param {string | any} value
     * cmd WE[oid]*[0/1]AU
     */
    sendLimitStatus(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WE${oid}*${value ? '1' : '0'}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendLimitStatus');
        }
    }

    /**
     * set limiter threshold in database
     * @param {string} oid
     * @param {string | any} value
     */
    setLimitThreshold(oid, value) {
        const self = this;
        try {
            const channel = self.oid2id(oid);
            self.setState(`${channel}threshold`, Number(0-value), true);
        } catch (err) {
            this.errorHandler(err, 'setLimitThreshold');
        }
    }

    /**
     * get limiter threshold from device
     * @param {string} baseId
     * cmd WT[oid]AU
     */
    getLimitThreshold(baseId) {
        const self = this;
        try {
            const oid = self.id2oid(`${baseId}.status`);
            if (oid) {
                self.streamSend(`WT${oid}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getLimitThreshold');
        }
    }

    /**
     * send new Limiter Threshold to device
     * @param {string} baseId
     * @param {string | any} value
     * cmd WT[oid]*[value]AU
     */
    sendLimitThreshold(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                self.streamSend(`WT${oid}*${value}AU\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendLimitThreshold');
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
            if (oid && self.playerLoaded[Number(oid)-1]) {
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
            if (oid && self.playerLoaded[Number(oid)-1]) {
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
     * @param {string} value
     */
    sendFileName(baseId, value) {
        const self = this;
        try {
            const oid = self.id2oid(baseId);
            if (oid) {
                const streamData = `WA${oid}*${(value === '' ? ' ' : value)}CPLY\r`;
                self.streamSend(streamData);
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
            self.playerLoaded[Number(oid)-1] = (value != '' ? true : false);
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

    /** BEGIN user flash memory file management */
    /** called to load a file into device user flash memory
     * @param {string} filePath
     */
    loadUserFile(filePath) {
        const self = this;
        let chunk ='';
        try {
            fs.accessSync(filePath);
            const fileName = path.basename(filePath);
            //const fileExt = path.extname(filePath);
            const fileStats = fs.statSync(filePath);
            const fileStream = fs.createReadStream(filePath);
            fileStream.setEncoding('binary');
            const fileTimeStamp = fileStats.mtime.toJSON();
            const year = fileTimeStamp.slice(0,4);
            const month = fileTimeStamp.slice(5,7);
            const day = fileTimeStamp.slice(8,10);
            const hour = fileTimeStamp.slice(11,13);
            const minute = fileTimeStamp.slice(14,16);
            const second = fileTimeStamp.slice(17,19);
            const streamData = `W+UF${fileStats.size}*7 ${month} ${day} ${year} ${hour} ${minute} ${second},${fileName}\r`;
            //const streamData = `W+UF${fileStats.size},${fileName}\r`;
            self.streamSend(streamData);
            //self.log.debug('stream pipe start');
            //fileStream.pipe(this.stream);
            fileStream.on('readable', function() {
                while ((chunk=fileStream.read()) != null) {
                    if (!self.fileSend) self.log.debug('loadUserFile started');
                    self.streamSend(chunk);
                    self.fileSend = true;
                    //self.timers.timeoutQueryStatus.refresh();
                }
                //self.fileSend = false;
            });
            fileStream.on('end', function() {
                self.fileSend = false;
                self.log.debug('loadUserFile completed');
            });
        } catch (err) {
            this.errorHandler(err, 'loadUserFile');
        }
    }

    /**
     * delete the user file from device
     * @param {string} value
     */
    eraseUserFile(value) {
        const self = this;
        try {
            const streamData = `W${(value === '' ? ' ' : value)}EF\r`;
            self.streamSend(streamData);
        } catch (err) {
            this.errorHandler(err, 'eraseUserFile');
        }
    }

    /** called to list current files in device user flash memory
     *
     */
    listUserFiles() {
        const self = this;
        try {
            self.streamSend(`WDF\r`);
            //self.requestDir = true;
        } catch (err) {
            self.requestDir = false;
            this.errorHandler(err, 'listUserFiles');
        }
    }

    /** called to set current files from device user flash memory in database
     * @param {string | Uint8Array} data
     */
    async setUserFilesAsync(data) {
        const self = this;
        try {
            const userFileList = data.toString().split('\r\r\n');               // split the list into separate lines
            //const actFiles = userFileList.length;
            let i;
            for (i=1; i<= self.fileList.files.length; i++) {
                await self.delObjectAsync(`fs.files.${i}.filename`);                  // delete filename state from database
                await self.delObjectAsync(`fs.files.${i}`);                         // delete file object from database
            }
            i = 1;
            for (const userFile of userFileList) {                              // check each line
                if (self.fileList.freeSpace) continue;                          // skip remaining lines if last entry already found
                else self.fileList.freeSpace = userFile.match(/(\d+\b Bytes Left)/g)?`${userFile.match(/(\d+\b Bytes Left)/g)[0]}`:'';     //check for last line containing remaining free space
                if (self.fileList.freeSpace) continue;                          // skip remaining lines if last entry already found
                self.file.fileName = userFile.match(/^(.+\.\w{3}\b)/g)?`${userFile.match(/^(.+\.\w{3}\b)/g)[0]}`:'';    // extract filename
                self.file.timeStamp = userFile.match(/(\w{3}, \d\d \w* \d* \W*\d\d:\d\d:\d\d)/g)?`${userFile.match(/(\w{3}, \d\d \w* \d* \W*\d\d:\d\d:\d\d)/g)[0]}`:''; //extract timestamp
                self.file.fileSize = userFile.match(/(\d+)$/g)?`${userFile.match(/(\d+)$/g)[0]}`:''; // extract filesize
                if (self.file.fileName.match(/.raw$/)) {        // check if AudioFile
                    self.fileList.files[i] = self.file;                             // add to filelist array
                    await self.setObjectNotExistsAsync(`fs.files.${i}`, self.objectsTemplate.userflash.files[0]);
                    await self.setObjectNotExistsAsync(`fs.files.${i}.filename`, self.objectsTemplate.userflash.files[1]);
                    self.setState(`fs.files.${i}.filename`, self.file.fileName, true);
                    i++;
                }
            }
            this.setState('fs.freespace',self.fileList.freeSpace,true);
        } catch (err) {
            self.requestDir = false;
            this.errorHandler(err, 'setUserFiles');
        }
    }
    /** END user flash memory file management */

    /** BEGIN cp82 Video control */

    /**
     * Set the database values for the tie state of an output
     * @param {string} cmd
     * @param {string} value
     * cmd = Inx, x=1..8; value=[1,2] All if not All set for all and log a warning
     */
    setTie(cmd, value) {
        const self = this;
        try {
            const input = cmd.substr(2,1);
            const valArray = value.split(' ');
            if (valArray[1] !== 'All') {
                self.log.warn(`Extron received tie status "${valArray[1]}". Only "All" supported. andle like "All"`);
            }
            self.setState(`connections.${valArray[0]}.tie`, Number(input), true);

        } catch (err) {
            this.errorHandler(err, 'setTie');
        }
    }

    /**
     * Send the tie status to the device
     * @param {string} baseId
     * @param {string | any} value
     */
    sendTieCommand(baseId, value) {
        const self = this;
        try {
            const idArray = baseId.split('.');
            if (idArray[2] === 'connections') {         // video.output
                if (Number(idArray[3]) <= 2) {
                    self.streamSend(`${value}*${idArray[3]}!\r`);   // tie input 'value' to output 'idArray[3]'
                } else {
                    if (value > 0) self.streamSend(`W${value}LOUT\r`);  // set loop out input to 'value'
                    else self.streamSend(`${value}*${idArray[3]}!\r`);  // untie loopOut
                }
            }
        } catch (err) {
            this.errorHandler(err, 'sendTieCommand');
        }
    }

    /**
     * Send Video mute command to the device
     * @param {string} baseId
     * @param {string | any} value
     */
    sendVideoMute(baseId, value) {
        const self = this;
        try {
            const idArray = baseId.split('.');
            if (idArray[2] === 'connections') {         // video.output
                if (self.devices[self.config.device].short === 'sme211') self.streamSend(`${value}B\r`);
                else self.streamSend(`${idArray[3]}*${value}B\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'sendVideoMute');
        }
    }

    /**
     * get Video mute status from device
     * @param {string} baseId
     */
    getVideoMute(baseId) {
        const self = this;
        try {
            const idArray = baseId.split('.');
            if (idArray[2] === 'connections') {         // video.output
                if (self.devices[self.config.device].short === 'sme211') self.streamSend(`B\r`);
                else self.streamSend(`${idArray[3]}*B\r`);
            }
        } catch (err) {
            this.errorHandler(err, 'getVideoMute');
        }
    }


    /** END CP83 Video control */

    /** BEGIN SMD202 Video Player control */
    /** send start payback command
     * cmd = WS1*1PLYR
     */
    sendPlayVideo() {
        const self = this;
        try {
            self.streamSend('WS1*1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'sendPlayVideo');
        }
    }

    /** send pause payback command
     * cmd = E1PLYR
     */
    sendPauseVideo() {
        const self = this;
        try {
            self.streamSend('WE1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'sendPauseVideo');
        }
    }

    /** send stop playback command
     * cmd = O1PLYR
     */
    sendStopVideo() {
        const self = this;
        try {
            self.streamSend('WO1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'sendStopVideo');
        }
    }

    /** get playback state
     * cmd = Y1PLYR
     */
    getPlayVideo() {
        const self = this;
        try {
            self.streamSend('WY1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'getPlayVideo');
        }
    }

    /** set playback state in database
     * @param {string} id
     * @param {number} mode
     */
    setPlayVideo(id, mode) {
        const self = this;
        try {
            self.setState(`${id}playmode`, mode, true);
        } catch (err) {
            this.errorHandler(err, 'setPlayVideo');
        }
    }

    /** send loop payback command
     * @param {string} id
     * @param {boolean} mode
     * cmd = R1*[mode]PLYR
     */
    sendLoopVideo(id, mode) {
        const self = this;
        try {
            self.streamSend(`WR${self.id2oid(id)}*${mode?1:0}PLYR\r`);
        } catch (err) {
            this.errorHandler(err, 'sendLoopVideo');
        }
    }

    /** get loop payback mode
     * cmd = R1*[mode]PLYR
     */
    getLoopVideo() {
        const self = this;
        try {
            self.streamSend('WR1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'getLoopVideo');
        }
    }

    /** set loop payback mode
     * @param {string} id
     * @param {boolean | string} mode
     */
    setLoopVideo(id, mode) {
        const self = this;
        try {
            self.setState(`${id}loopmode`, Number(mode)?true:false, true);
        } catch (err) {
            this.errorHandler(err, 'setLoopVideo');
        }
    }

    /** send path and fileneame
     * @param {string} id
     * @param {string} path
     * cmd = U1*[path]
     */
    sendVideoFile(id, path) {
        const self = this;
        try {
            self.streamSend(`WU${self.id2oid(id)}*${path}PLYR\r`);
        } catch (err) {
            this.errorHandler(err, 'sendVideoFile');
        }
    }

    /** get path and fileneame
     * cmd = U1PLYR
     */
    getVideoFile() {
        const self = this;
        try {
            self.streamSend('WU1PLYR\r');
        } catch (err) {
            this.errorHandler(err, 'getVideoFile');
        }
    }

    /**
     * Set the Player filename in the database
     * @param {string} id
     * @param {string} path
     */
    setVideoFile(id, path) {
        const self = this;
        try {
            self.setState(`${id}filepath`, path, true);
            self.playerLoaded[0] = (path != '' ? true : false);
        } catch (err) {
            this.errorHandler(err, 'setVideoFile');
        }
    }
    /** END SMD 2020 Video Player Control */

    /** BEGIN SME211 stream control */
    /** send streaming mode to device
     * @param {number} mode
     *  cmd = Y[mode]STRM
    */
    sendStreamMode(mode) {
        const self = this;
        try {
            self.streamSend(`WY${mode}STRM\r`);
        } catch (err) {
            this.errorHandler(err, 'sendStreamMode');
        }
    }

    /** set streammode state in database
     * @param {string} id
     * @param {number} mode
     */
    setStreamMode(id, mode) {
        const self = this;
        try {
            self.setState(`${id}streammode`, mode);
        } catch (err) {
            this.errorHandler(err, 'setStreamMode');
        }
    }

    /** get streammode from device
     *  cmd = YSTRM
     */
    getStreamMode() {
        const self = this;
        try {
            self.streamSend('WYSTRM\r');
        } catch (err) {
            this.errorHandler(err, 'getStreamMode');
        }
    }
    /** END SME 211 stream control */

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
                        if (self.devices[self.config.device].short === 'cp82') {    // mixpoints on CP82
                            if ( where < 2) {
                                retId = `in.programInputs.${('00' + (where +1).toString()).slice(-2)}.mixPoints.`;
                            } else if (where < 4) {
                                retId = `in.inputs.${('00' + (where -1).toString()).slice(-2)}.mixPoints.`;
                            } else if (where < 6) {
                                retId = `in.lineInputs.${('00' + (where -3).toString()).slice(-2)}.mixPoints.`;
                            } else if (where < 8) {
                                retId = `in.playerInputs.${('00' + (where -5).toString()).slice(-2)}.mixPoints.`;
                            }
                        } else                      // mixpoints on dmp128
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
                        if (self.devices[self.config.device].short === 'cp82') {    // mixpoints on CP82
                            retId += `O${('00' + (val -1).toString()).slice(-2)}.`; // on CP82 mixpooint output OID count starts at 2
                        } else                      // mixpoints on dmp128
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

                    case 3:                         // VideoLine inputs on CP82
                        if (where === 0) {          // Input Gain Control
                            return `in.videoInputs.${('00' + (val + 1).toString()).slice(-2)}.premix.`;
                        }
                        break;

                    case 4:                         // input block
                        if (where === 0) {          // Input gain block
                            if (self.devices[self.config.device].short === 'cp82'){ // Inputs on CP82
                                if ( val < 2) {
                                    return `in.inputs.${('00' + (val +1).toString()).slice(-2)}.gain.`;
                                } else if (val < 4) {
                                    return `in.lineInputs.${('00' + (val -1).toString()).slice(-2)}.gain.`;
                                } else if (val < 6) {
                                    return `in.playerInputs.${('00' + (val -3).toString()).slice(-2)}.gain.`;
                                }
                            } else if (val <= 11) {        // input 1 - 12
                                return `in.inputs.${('00' + (val + 1).toString()).slice(-2)}.gain.`;
                            }
                            if (val <= 19) {        // aux input 1 - 8
                                return `in.auxInputs.${('00' + (val - 11).toString()).slice(-2)}.gain.`;
                            }
                        } else if (where === 1) {   // premix gain block
                            if (self.devices[self.config.device].short === 'cp82'){ // Inputs on CP82
                                if ( val < 2) {
                                    return `in.inputs.${('00' + (val +1).toString()).slice(-2)}.premix.`;
                                } else if (val < 4) {
                                    return `in.lineInputs.${('00' + (val -1).toString()).slice(-2)}.premix.`;
                                } else if (val < 6) {
                                    return `in.playerInputs.${('00' + (val -3).toString()).slice(-2)}.premix.`;
                                }
                            } else if (val <= 11) {        // input 1 - 12
                                return `in.inputs.${('00' + (val + 1).toString()).slice(-2)}.premix.`;
                            } else if (val <= 19) {        // aux input 1 - 8
                                return `in.auxInputs.${('00' + (val - 11).toString()).slice(-2)}.premix.`;
                            }
                        }
                        throw { 'message': 'no known input',
                            'stack'  : `oid: ${oid}` };

                    case 5:                         // virtual return or ext input or program
                        if (where === 0) {           // program inputs on CP82
                            return `in.programInputs.${('00' + (val +1).toString()).slice(-2)}.premix.`;
                        }
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
                            if (self.devices[self.config.device].short === 'cp82') {    // outputs on CP82
                                return `out.outputs.${('00' + (val -1).toString()).slice(-2)}.attenuation.`; // ouput OID starts at 2 on CP82
                            }
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
                        if (where === 40) {          // limiter block
                            if (val <= 7) {         // output 1 - 8
                                return `out.outputs.${('00' + (val + 1).toString()).slice(-2)}.limiter.`;
                            }
                            if (val <= 15) {        // aux output 1 - 8
                                return `out.auxOutputs.${('00' + (val - 7).toString()).slice(-2)}.limiter.`;
                            }
                            if (val <= 31) {        // expansion output 1-16
                                return `out.expansionOutputs.${('00' + (val - 15).toString()).slice(-2)}.limiter.`;
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
                        case 'videoInputs':
                            retOid = `300${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            break;

                        case 'inputs':
                            if (idBlock === 'gain') {
                                retOid = `400${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            } else {
                                retOid = `401${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            }
                            break;

                        case 'programInputs' :
                            retOid = `500${('00' + (idNumber - 1).toString()).slice(-2)}`;             // program inputs on CP82
                            break;

                        case 'lineInputs' :
                            if (idBlock === 'gain') {
                                retOid = `400${('00' + (idNumber +1).toString()).slice(-2)}`;         // Line Inputs on CP82
                            } else {
                                retOid = `401${('00' + (idNumber +1).toString()).slice(-2)}`;
                            }
                            break;

                        case 'playerInputs' :
                            if (idBlock === 'gain') {
                                retOid = `400${('00' + (idNumber +3).toString()).slice(-2)}`;         // player inputs on CP82
                            } else {
                                retOid = `401${('00' + (idNumber +3).toString()).slice(-2)}`;
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
                            switch (idBlock) {
                                case 'attenuation' :
                                    retOid = `600${('00' + (idNumber - 1).toString()).slice(-2)}`;
                                    if (self.devices[self.config.device].short === 'cp82') retOid = `600${('00' + (idNumber +1).toString()).slice(-2)}`; // output OID count starts at 2 on CP82
                                    break;
                                case 'limiter' :
                                    retOid = `640${('00' + (idNumber - 1).toString()).slice(-2)}`;
                                    break;
                                default:
                                    retOid = `601${('00' + (idNumber - 1).toString()).slice(-2)}`;
                            }
                            break;

                        case 'auxOutputs' :
                            switch (idBlock) {
                                case 'attenuation' :
                                    retOid = `600${('00' + (idNumber + 7).toString()).slice(-2)}`;
                                    break;
                                case 'limiter' :
                                    retOid = `640${('00' + (idNumber + 7).toString()).slice(-2)}`;
                                    break;
                                default :
                                    retOid = `601${('00' + (idNumber + 7).toString()).slice(-2)}`;
                            }
                            break;

                        case 'expansionOutputs' :
                            switch (idBlock) {
                                case 'attenuation' :
                                    retOid = `600${('00' + (idNumber + 15).toString()).slice(-2)}`;
                                    break;
                                case 'limiter' :
                                    retOid = `640${('00' + (idNumber + 15).toString()).slice(-2)}`;
                                    break;
                                default:
                                    retOid = `601${('00' + (idNumber + 15).toString()).slice(-2)}`;
                            }
                            break;

                        default:
                            if (idBlock === 'name') retOid = idNumber.toString();
                            else retOid = '';
                    }
                }   else
                {                      // mixpoints
                    switch (idType) {
                        case 'inputs':
                            retOid = `2${('00' + (idNumber -1).toString()).slice(-2)}`;
                            if (self.devices[self.config.device].short === 'cp82') retOid = `2${('00' + (idNumber +1).toString()).slice(-2)}`; // Mic Inputs on CP82
                            break;

                        case 'programInputs' :
                            retOid = `2${('00' + (idNumber -1).toString()).slice(-2)}`;         // program inputs on CP82
                            break;

                        case 'playerInputs' :
                            retOid = `2${('00' + (idNumber +5).toString()).slice(-2)}`;         // FilePlayer Inouts on CP82
                            break;

                        case 'lineInputs' :
                            retOid = `2${('00' + (idNumber +3).toString()).slice(-2)}`;         // Line Inputs on CP82
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
                            if (self.devices[self.config.device].short === 'cp82') {
                                retOid += ('00' + (outputNumber +1).toString()).slice(-2);  // output OID count starts at 2 on CP82
                            } else {
                                retOid += ('00' + (outputNumber - 1).toString()).slice(-2);
                            }
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
            clearTimeout(this.timers.intervallQueryStatus);

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
                    if ((state.val === undefined) || (state.val === null)) state.val = '';
                    const baseId = id.substr(0, id.lastIndexOf('.'));
                    const idArray = id.split('.');
                    const idType = idArray[3];
                    const idBlock = idArray[5];
                    const stateName = id.substr(id.lastIndexOf('.') + 1);
                    const timeStamp = Date.now();
                    let stateTime = self.stateBuf[0];
                    let calcMode ='lin';
                    let elapsed = 0;
                    if (typeof(baseId) !== 'undefined' && baseId !== null) {
                        switch (stateName) {
                            case 'mute' :
                                if (idArray[2] === 'connections') {
                                    self.sendVideoMute(id, state.val);
                                } else self.sendMuteStatus(id,state.val);
                                break;
                            case 'source' :
                                self.sendSource(id, state.val.toString());
                                break;
                            case 'level' :
                                stateTime = self.stateBuf.find(stateTime => stateTime.id === id);   // check if state has already been buffered
                                if (stateTime === undefined) {
                                    self.stateBuf.push({'id' : id, 'timestamp' : 0});               // push state to buffer array
                                    stateTime = self.stateBuf.find(stateTime => stateTime.id === id); // now it should be found
                                }
                                elapsed = timeStamp - stateTime.timestamp;  // calcualte elapsed milliseconds since last change
                                if ( elapsed > self.config.stateDelay) {    // if configured stateDelay has been exceeded, process the change event
                                    switch (idBlock) {
                                        case 'gain' :
                                            calcMode = 'linGain';
                                            if (idType === 'auxInputs') calcMode = 'linAux';
                                            if (self.devices[self.config.device].short === 'sme211') calcMode = 'linAux';
                                            break;

                                        case 'premix' :
                                            if (self.devices[self.config.device].short === 'cp82') calcMode = 'linAux';
                                            break;

                                        case 'postmix' :
                                            calcMode = 'linTrim';
                                            break;

                                        case 'attenuation' :
                                            calcMode = 'linAtt';
                                            break;
                                    }
                                    stateTime.timestamp = timeStamp;    // update stored timestamp
                                    self.sendGainLevel(id,self.calculateFaderValue(state.val.toString(),calcMode));
                                }
                                break;
                            case 'level_db' :
                                calcMode ='log';
                                switch (idBlock) {
                                    case 'gain' :
                                        calcMode = 'logGain';
                                        if (idType === 'auxInputs') calcMode = 'logAux';
                                        if (idType === 'lineInputs') calcMode = 'logAux';
                                        break;

                                    case 'premix' :
                                        if (self.devices[self.config.device].short === 'cp82') calcMode = 'logAux';
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

                            case 'status' :
                                self.sendLimitStatus(id, state.val);
                                break;
                            case 'threshold':
                                self.sendLimitThreshold(id, Math.abs(Number((state.val < -800)?-800:(state.val>0)?0:state.val)));
                                break;

                            case 'playmode' :
                                if (self.devices[self.config.device].short === 'smd202') {
                                    switch (state.val) {
                                        case 0: self.sendStopVideo(); break;
                                        case 1: self.sendPlayVideo(); break;
                                        case 2: self.sendPauseVideo(); break;
                                    }
                                }
                                else self.sendPlayMode(id, state.val);
                                break;

                            case 'repeatmode' :
                                self.sendRepeatMode(id, state.val);
                                break;

                            case 'filename' :
                                self.sendFileName(id, state.val.toString());
                                break;

                            case 'tie' :
                                self.sendTieCommand(baseId, state.val);
                                break;
                            case 'loopmode' :
                                self.sendLoopVideo(baseId, state.val?true:false);
                                break;
                            case 'filepath' :
                                self.sendVideoFile(baseId, state.val.toString());
                                break;
                            case 'streammode' :
                                self.sendStreamMode(Number(state.val));
                                break;

                            case 'dir' :
                                self.listUserFiles();
                                break;

                            case 'upl' :
                                self.loadUserFile(`${state.val}`);
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
	 * @param {any} err
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