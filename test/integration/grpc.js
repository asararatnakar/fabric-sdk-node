/**
 * Copyright 2017 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

'use strict';

var utils = require('fabric-client/lib/utils.js');
var logger = utils.getLogger('query');

var tape = require('tape');
var _test = require('tape-promise');
var test = _test(tape);

var path = require('path');
var util = require('util');
var fs = require('fs');
var crypto = require('crypto');

var e2eUtils = require('./e2e/e2eUtils.js');
var testUtil = require('../unit/util.js');
var Client = require('fabric-client');

var e2e = testUtil.END2END;

/*
 * The test depends on an existing channel 'mychannel'
 */
test('\n\n*** GRPC communication tests ***\n\n', (t) => {
	testUtil.resetDefaults();

	// test grpc message size limit
	var client = new Client();
	var channel = client.newChannel(e2e.channel);
	var ORGS = Client.getConfigSetting('test-network');
	var userOrg = 'org1';
	var orgName = ORGS[userOrg].name;
	var submitter;
	var tlsInfo = null;

	var cryptoSuite = Client.newCryptoSuite();
	cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(orgName)}));
	client.setCryptoSuite(cryptoSuite);

	var junkpath = path.join(__dirname, '../fixtures/src/github.com/example_cc/junk.go');
	// create a file of size 1M
	fs.writeFile(junkpath, crypto.randomBytes(1024 * 1024));

	// override t.end function so it'll always disconnect the event hub
	t.end = ((context, file, f) => {
		return function() {
			fs.unlinkSync(file);

			f.apply(context, arguments);
		};
	})(t, junkpath, t.end);

	testUtil.setupChaincodeDeploy();

	//force the use of the old v1.0 way
	utils.setConfigSetting('grpc.max_send_message_length', 0);
	// limit the send message size to 1M
	utils.setConfigSetting('grpc-max-send-message-length', 1024 * 1024);
	// now that we have set the config setting, create a new peer so that it will
	// pick up the settings which are only done when the peer is created.
	e2eUtils.tlsEnroll(userOrg)
	.then((enrollment) => {
		t.pass('Successfully retrieved TLS certificate');
		tlsInfo = enrollment;
		return e2eUtils.installChaincode(userOrg, testUtil.CHAINCODE_PATH, null, 'v2', 'golang', t, true);
	}).then(() => {
		t.fail('Should have failed because the file size is too big for grpc send messages');
		t.end();
	}, (err) => {
		if (err.message && err.message.indexOf('Sent message larger than max') >= 0) {
			t.pass('Successfully received the error message due to large message size');
		} else {
			t.fail(util.format('Unexpected error: %s' + err.stack ? err.stack : err));
		}

		// now dial the send limit up
		// utils.setConfigSetting('grpc.max_send_message_length', 1024 * 1024 * 2);
		utils.setConfigSetting('grpc-max-send-message-length', 1024 * 1024 * 2);
		// be sure to create a new peer to pick up the new settings

		return e2eUtils.installChaincode('org1', testUtil.CHAINCODE_PATH, null, 'v2', 'golang', t, true);
	}).then(() => {
		t.pass('Successfully tested setting grpc send limit');

		Client.addConfigFile(path.join(__dirname, './e2e/config.json'));

		return Client.newDefaultKeyValueStore({path: testUtil.storePathForOrg(orgName)});
	}).then((store) => {
		client.setStateStore(store);

		return testUtil.getSubmitter(client, t, userOrg, true);
	}).then((admin) => {

		submitter = admin;
		//force the use of the old v1.0 way
		utils.setConfigSetting('grpc.max_receive_message_length', 0);
		// limit the send message size to 1M
		utils.setConfigSetting('grpc-max-receive-message-length', 10);
		client.setTlsClientCertAndKey(tlsInfo.certificate, tlsInfo.key);
		// for this test we only need to send to one of the peers in org1
		let data = fs.readFileSync(path.join(__dirname, 'e2e', ORGS[userOrg].peer1['tls_cacerts']));
		let peer = client.newPeer(
			ORGS[userOrg].peer1.requests,
			{
				pem: Buffer.from(data).toString(),
				'clientCert': tlsInfo.certificate,
				'clientKey': tlsInfo.key,
				'ssl-target-name-override': ORGS[userOrg].peer1['server-hostname'],
			}
		);

		return channel.sendTransactionProposal(buildEchoRequest(client, peer));
	}).then((response) => {
		var err = (response[0] && response[0][0] && response[0][0] instanceof Error) ? response[0][0] : {};

		if (err.message && err.message.indexOf('Received message larger than max') >= 0) {
			t.pass('Successfully received the error message due to large message size set using old v1.0 type setting');
		} else {
			t.fail(util.format('Unexpected error: %s' + err.stack ? err.stack : err));
			t.end();
			throw new Error('Test Failed');
		}

		// now dial the send limit up by setting to -1 for unlimited
		// utils.setConfigSetting('grpc.max_receive_message_length', -1);
		utils.setConfigSetting('grpc-max-receive-message-length', -1);

		// must re-construct a new peer instance to pick up the new setting
		let data = fs.readFileSync(path.join(__dirname, 'e2e', ORGS[userOrg].peer1['tls_cacerts']));
		let peer = client.newPeer(
			ORGS[userOrg].peer1.requests,
			{
				pem: Buffer.from(data).toString(),
				'clientCert': tlsInfo.certificate,
				'clientKey': tlsInfo.key,
				'ssl-target-name-override': ORGS[userOrg].peer1['server-hostname']
			}
		);

		return channel.sendTransactionProposal(buildEchoRequest(client, peer));
	}).then((response) => {
		if (response[0] && response[0][0] && response[0][0].response && response[0][0].response.status === 200)
			t.pass('Successfully tested grpc receive message limit reset after it was set too low');
		else
			t.fail(util.format('Failed to effectively use config setting to control grpc receive message limit. %s', response[0][0]));

		// for this test we only need to send to one of the peers in org1
		let data = fs.readFileSync(path.join(__dirname, 'e2e', ORGS[userOrg].peer1['tls_cacerts']));
		let peer = client.newPeer(
			ORGS[userOrg].peer1.requests,
			{
				pem: Buffer.from(data).toString(),
				'clientCert': tlsInfo.certificate,
				'clientKey': tlsInfo.key,
				'ssl-target-name-override': ORGS[userOrg].peer1['server-hostname'],
				// now dial the receive limit back down to reproduce the message size error
				// notice this is another way to set a grpc setting, this will override
				// what is in the config setting.
				'grpc-max-receive-message-length': 10
				// 'grpc.max_receive_message_length': 10
			}
		);

		return channel.sendTransactionProposal(buildEchoRequest(client, peer));
	}).then((response) => {
		var err = (response[0] && response[0][0] && response[0][0] instanceof Error) ? response[0][0] : {};

		if (err.message && err.message.indexOf('Received message larger than max') >= 0) {
			t.pass('Successfully received the error message due to large message size set into the options');
		} else {
			t.fail(util.format('Unexpected error: %s' + err.stack ? err.stack : err));
			t.end();
			throw new Error('Test Failed');
		}
		// now dial the send limit up by setting to -1 for unlimited
		// utils.setConfigSetting('grpc.max_receive_message_length', -1);
		// utils.setConfigSetting('grpc.max_send_message_length', -1);
		utils.setConfigSetting('grpc-max-receive-message-length', -1);
		utils.setConfigSetting('grpc-max-send-message-length', -1);
		let submitterCert = submitter.getIdentity()._certificate;
		let submitterKey = submitter.getSigningIdentity()._key;

		// must re-construct a new peer instance to pick up the new setting
		let data = fs.readFileSync(path.join(__dirname, 'e2e', ORGS[userOrg].peer1['tls_cacerts']));
		let peer = client.newPeer(
			ORGS[userOrg].peer1.requests,
			{
				pem: Buffer.from(data).toString(),
				'clientCert': tlsInfo.certificate,
				'clientKey': tlsInfo.key,
				'ssl-target-name-override': ORGS[userOrg].peer1['server-hostname']
			}
		);

		return channel.sendTransactionProposal(buildEchoRequest(client, peer));
	}).then((response) => {
		if (response[0] && response[0][0] && response[0][0].response && response[0][0].response.status === 200)
			t.pass('Successfully tested grpc receive message limit');
		else
			t.fail(util.format('Failed to effectively use config setting to control grpc receive message limit. %s', response[0][0]));

		t.end();
	}).catch((err) => {
		t.fail('Test failed due to unexpected reasons. ' + err.stack ? err.stack : err);
		t.end();
	});
});

function buildEchoRequest(client, peer) {
	let nonce = utils.getNonce();
	let tx_id = client.newTransactionID();

	return {
		targets: [peer],
		chaincodeId : e2e.chaincodeId,
		fcn: 'echo',
		args: [crypto.randomBytes(1024 * 1024)],
		txId: tx_id,
		nonce: nonce
	};
}
