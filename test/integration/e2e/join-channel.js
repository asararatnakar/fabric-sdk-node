/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
'use strict';

var utils = require('fabric-client/lib/utils.js');
var logger = utils.getLogger('E2E join-channel');

var tape = require('tape');
var _test = require('tape-promise');
var test = _test(tape);

var util = require('util');
var path = require('path');
var fs = require('fs');

var Client = require('fabric-client');

var testUtil = require('../../unit/util.js');
var e2eUtils = require('./e2eUtils.js');

var the_user = null;
var tx_id = null;

var ORGS;

//
//Attempt to send a request to the orderer with the createChannel method
//
test('\n\n***** End-to-end flow: join channel *****\n\n', function(t) {
	Client.addConfigFile(path.join(__dirname, './config.json'));
	ORGS = Client.getConfigSetting('test-network');

	joinChannel('org1', t)
	.then(() => {
		t.pass(util.format('Successfully joined peers in organization "%s" to the channel', ORGS['org1'].name));
		return joinChannel('org2', t);
	}, (err) => {
		t.fail(util.format('Failed to join peers in organization "%s" to the channel. %s', ORGS['org1'].name, err.stack ? err.stack : err));
		t.end();
	})
	.then(() => {
		t.pass(util.format('Successfully joined peers in organization "%s" to the channel', ORGS['org2'].name));
		t.end();
	}, (err) => {
		t.fail(util.format('Failed to join peers in organization "%s" to the channel. %s', ORGS['org2'].name), err.stack ? err.stack : err);
		t.end();
	})
	.catch(function(err) {
		t.fail('Failed request. ' + err);
		t.end();
	});
});

function joinChannel(org, t) {
	var channel_name = Client.getConfigSetting('E2E_CONFIGTX_CHANNEL_NAME', testUtil.END2END.channel);
	//
	// Create and configure the test channel
	//
	var client = new Client();
	var channel = client.newChannel(channel_name);

	var orgName = ORGS[org].name;

	var targets = [];

	var caRootsPath = ORGS.orderer.tls_cacerts;
	let data = fs.readFileSync(path.join(__dirname, caRootsPath));
	let caroots = Buffer.from(data).toString();
	var genesis_block = null;
	var tlsInfo = null;

	return e2eUtils.tlsEnroll(org)
	.then((enrollment) => {
		t.pass('Successfully retrieved TLS certificate');
		tlsInfo = enrollment;
		return Client.newDefaultKeyValueStore({path: testUtil.storePathForOrg(orgName)});
	}).then((store) => {
		client.setStateStore(store);

		return testUtil.getOrderAdminSubmitter(client, t);
	}).then((admin) => {
		t.pass('Successfully enrolled orderer \'admin\' (joined_channel 1)');
		client.setTlsClientCertAndKey(tlsInfo.certificate, tlsInfo.key);
		channel.addOrderer(
			client.newOrderer(
				ORGS.orderer.url,
				{
					'pem': caroots,
					'clientCert': tlsInfo.certificate,
					'clientKey': tlsInfo.key,
					'ssl-target-name-override': ORGS.orderer['server-hostname']
				}
			)
		);
		tx_id = client.newTransactionID();
		let request = {
			txId : 	tx_id
		};

		return channel.getGenesisBlock(request);
	}).then((block) =>{
		t.pass('Successfully got the genesis block');
		genesis_block = block;

		// get the peer org's admin required to send join channel requests
		client._userContext = null;

		return testUtil.getSubmitter(client, t, true /* get peer org admin */, org);
	}).then((admin) => {
		t.pass('Successfully enrolled org (join_channel):' + org + ' \'admin\'');
		the_user = admin;

		for (let key in ORGS[org]) {
			if (ORGS[org].hasOwnProperty(key)) {
				if (key.indexOf('peer') === 0) {
					data = fs.readFileSync(path.join(__dirname, ORGS[org][key]['tls_cacerts']));
					targets.push(
						client.newPeer(
							ORGS[org][key].requests,
							{
								pem: Buffer.from(data).toString(),
								'clientCert': tlsInfo.certificate,
								'clientKey': tlsInfo.key,
								'ssl-target-name-override': ORGS[org][key]['server-hostname']
							}
						)
					);
				}
			}
		}

		tx_id = client.newTransactionID();
		let request = {
			targets : targets,
			block : genesis_block,
			txId : 	tx_id
		};

		return channel.joinChannel(request, 30000);
	}, (err) => {
		t.fail('Failed to enroll user \'admin\' due to error: ' + err.stack ? err.stack : err);
		throw new Error('Failed to enroll user \'admin\' due to error: ' + err.stack ? err.stack : err);
	})
	.then((results) => {
		logger.debug(util.format('Join Channel R E S P O N S E : %j', results));

		if(results && results[0] && results[0].response && results[0].response.status == 200) {
			t.pass(util.format('Successfully joined peers in organization %s to join the channel', orgName));
		} else {
			t.fail(' Failed to join channel');
			throw new Error('Failed to join channel');
		}
	}, (err) => {
		t.fail('Failed to join channel due to error: ' + err.stack ? err.stack : err);
	});
}
