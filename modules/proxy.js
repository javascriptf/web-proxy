/* -----
 * Proxy
 * -----
 * 
 * Provides an HTTP Proxy (without routing) along with its monitoring.
 * 
 * License:
 * Web Proxy, Copyright (c) 2010-2014, Subhajit Sahu, All Rights Reserved.
 * see: /LICENSE.txt for details.
 */


// dependencies
var url  = require('url');
var http = require('http');
var tank     = require('./tank')();
var config   = require('./config')();
var objbuild = require('./objbuild')();


module.exports = function(dep, inj) {
	// initialize
	var o = {};
	var log = dep.log;
	var httpAgent = new http.Agent();
	try      { o.maxLen = dep.maxLen; }
	catch(e) { o.maxLen = 32; }



	// proxy status
	o.status = {
		'client': {
			'request':  0,
			'response': 0
		},
		'proxy': {
			'request':  0,
			'response': 0
		},
		'pending': 0,
		'failed':  0
	};



	// proxy history
	o.history = {
		'client': {
			'request':  [],
			'response': []
		},
		'proxy': {
			'request':  [],
			'response': []
		},
		'pending': [],
		'failed':  []
	};



	// proxy running record
	o.record = {
		'active': [],
		'failed': []
	};

	
	
	// record client request and return id
	o.recClientReq = function(req) {

		// get log of active transfers
		var rAct = o.record.active;

		// get transfer id and update status
		var id = ++o.status.client.request;
		++o.status.pending;

		// if transfers' log full and has no response (failed)
		if (rAct.length >= 32 && rAct[0].proxy.response === null) {
			
			// update status (failed)
			--o.status.pending;
			++o.status.failed;
			
			// add failed transfer to failed record
			tank.add(o.record.failed, rAct[0]);
		}

		// log client request
		tank.add(rAct, {
			'id': id,
			'client': {
				'request':  {
					'time': process.hrtime()[0],
					'url':      req.url,
					'method':   req.method,
					'headers':  objbuild.copy([req.headers]),
					'version':  req.httpVersion,
					'trailers': req.trailers
				},
				'response': null
			},
			'proxy': {
				'request':  null,
				'response': null
			}
		});

		// return transfer id
		return id;
	};



	// record proxy request
	o.recProxyReq = function(id, req) {

		// get log of active transfers
		var rAct = o.record.active;

		// update status
		++o.status.proxy.request;

		// find the log of requested id
		for (var i = 0; i < rAct.length; i++) {
			if (rAct[i].id !== id) continue;

			// log proxy request
			rAct[i].proxy.request = {
				'time': process.hrtime()[0],
				'url':      req.url,
				'method':   req.method,
				'headers':  objbuild.copy([req.headers]),
				'version':  req.httpVersion,
				'trailers': req.trailers
			};
			break;
		}
	};



	// record proxy response
	o.recProxyRes = function(id, res) {

		// get log of active transfers
		var rAct = o.record.active;

		// update status
		++o.status.proxy.response;

		// find log of requested id
		for (var i = 0; i < rAct.length; i++) {
			if (rAct[i].id !== id) continue;

			// log proxy response
			rAct[i].proxy.response = {
				'time': process.hrtime()[0],
				'status':   res.statusCode,
				'headers':  objbuild.copy([res.headers]),
				'version':  res.httpVersion,
				'trailers': res.trailers
			};
			break;
		}
	};



	// record client response
	o.recClientRes = function(id, res) {

		// get log of active transfers
		var rAct = o.record.active;

		// update status
		++o.status.client.response;
		--o.status.pending;

		// find log of requested id
		for (var i = 0; i < rAct.length; i++) {
			if (rAct[i].id !== id) continue;

			// log client response
			rAct[i].client.response = {
				'time': process.hrtime()[0],
				'status':   res.statusCode,
				'headers':  objbuild.copy([res.headers]),
				'version':  res.httpVersion,
				'trailers': res.trailers
			};
			break;
		}
	};



	// update proxy history
	o.updateHistory = function() {
		var hReq = o.history.request, hRes = o.history.response;
		var sReq = o.status.request,  sRes = o.status.response;
		tank.add(o.history.client.request,  o.status.client.request);
		tank.add(o.history.client.response, o.status.client.response);
		tank.add(o.history.proxy.request,   o.status.proxy.request);
		tank.add(o.history.proxy.response,  o.status.proxy.response);
		tank.add(o.history.pending, o.status.pending);
		tank.add(o.history.failed,  o.status.failed);
	};



	// handle response from server
	o.handleRes = function(id, res, pRes) {
		
		// record transfer (response to proxy)
		o.recProxyRes(id, pRes);

		// get response headers
		var hdr = pRes.headers;

		// log start of response to proxy
		log.write('['+id+'] Response to Proxy started.');
		
		// save content-length in server http header
		hdr['server'] = hdr['content-length']? hdr['content-length'] : '?';
		
		// set transfer encoding to chunked, if not set
		if(!hdr['transfer-encoding']) hdr['transfer-encoding'] = 'chunked';

		// remove bad headers
		delete hdr['content-length'];

		// on response error, log and end response
		res.on('error', function(err) {
			log.write('['+id+'] Error with response to Client: '+err.message+'.');
			res.end();
		});

		// write headers to client
		res.writeHead(pRes.statusCode, hdr);

		// stream data to the client
		pRes.on('data', function(chunk) {
			res.write(chunk);
		});

		// handle end of response
		pRes.on('end', function() {

			// add trailers if available
			if (pRes.trailers) res.addTrailers(pRes.trailers);

			// log completion of response to client and end
			log.write('['+id+'] Response to Client complete.');
			res.end();

			// record tranfer (client response)
			o.recClientRes(id, {
				'statusCode':  pRes.statusCode,
				'headers':     hdr,
				'httpVersion': pRes.httpVersion,
				'trailers':    pRes.trailers
			});
		});
	};



	// handle request from client
	o.handleReq = function(req, res) {

		// log transfer (client request) and get id
		var id = o.recClientReq(req);
		
		// get request address (href)
		var hdr = req.headers;
		var addr = url.parse(hdr['user-agent']);

		// update header information
		hdr['user-agent'] = config.usrAgent;
		hdr['host'] = addr.host;

		// get options for remote request
		var options = {
			'method':  req.method,
			'host':    addr.host,
			'auth':    addr.auth,
			'port':    addr.port,
			'path':    addr.path+(addr.hash || ''),
			'headers': hdr,
			'agent':   httpAgent
		};

		// log remote request address
		log.write('['+id+'] Request address to Proxy: '+addr.href+'.');

		// make request to remote server and handle reponse
		var pReq = http.request(options, function(pRes) {
			o.handleRes(id, res, pRes);
		});

		// on error with request send internal error message to client
		pReq.on('error', function(err) {
			log.write('['+id+'] Problem with Proxy request: '+err.message+'.');
			console.log(httpAgent);
			httpAgent = new http.Agent();
			res.send(500);
		});

		// stream data to remote server
		req.on('data', function(chunk) {
			pReq.write(chunk);
		});

		// handle end of client request
		req.on('end', function() {

			// send trailers is present
			if (req.trailers) pReq.addTrailers(req.trailers);

			// log completion of proxt request and end remote request
			log.write('['+id+'] Proxy Request complete.');
			pReq.end();

			// log transfer (proxy request)
			o.recProxyReq(id, {
				'method':      req.method,
				'headers':     hdr,
				'httpVersion': req.httpVersion,
				'trailers':    req.trailers
			});
			log.write('['+id+'] Proxy Request complete.');
		});
	};



	// return
	if(typeof inj !== 'undefined') {
		inj.status  = o.status;
		inj.history = o.history;
		inj.record  = o.record;
	}
	return o;
};