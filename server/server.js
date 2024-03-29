const express        = require("express");
const fetch          = require("node-fetch");
const net            = require("net");
const xml2js         = require("xml2js");
const throttledQueue = require("throttled-queue");
const util           = require("util");
const fs             = require("fs");

const USER_AGENT = "online-emerg-alert-fetcher/0.1";
const TCP_API_SERVERS = {
  canada: [
    {
      host: "streaming1.naad-adna.pelmorex.com",
      port: 8080,
      name: "AlertReady Oakville server",
    }, {
      host: "streaming2.naad-adna.pelmorex.com",
      port: 8080,
      name: "AlertReady Montreal server",
    }
  ]
};
const PER_BACKEND_FUNCS = {
  canada: {
    isHeartbeat: function(alert) {
      return alert.sender === "NAADS-Heartbeat";
    },
    normalizeArchivePortion: function(str) {
      // page 24 of LMD guide
      return str
        // The minus sign (- or dash) is replaced by underscore character (_)
        .replace(/(-|-|−)/g, "_") // (there are multie types of dashes/minus signs)
        // The plus sign (+) is replaced by ‘p’ (lower case)
        .replace(/\+/g, "p")
        // The colon character (:) is replaced by underscore character (_)
        .replace(/:/g, "_");
    },
    // check if an alert is correctly signed
    checkIfAlertSigned: async function(alert) {

    },
    oldAlertQueue: throttledQueue(2, 1500), // at most 2 requests every 1.5 seconds
    fetchOldAlert: async function(ref, forceBackupServer = false, isRawUrl = false) {
      // page 24 of the LMD guide
      // cap-pac@canada.ca,urn:oid:2.49.0.1.124.4280542342.2020,2020-03-06T14:32:38-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.2271109197.2020,2020-03-06T14:33:38-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.2825789534.2020,2020-03-06T14:32:34-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.2654922216.2020,2020-03-06T14:32:27-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.1308899007.2020,2020-03-06T15:32:42-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.3622084484.2020,2020-03-06T15:33:17-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.2302068752.2020,2020-03-06T15:33:42-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.2627528432.2020,2020-03-06T15:34:17-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.1656974427.2020,2020-03-06T15:53:15-00:00 cap-pac@canada.ca,urn:oid:2.49.0.1.124.2963379165.2020,2020-03-06T15:53:24-00:00
      
      return await new Promise((resolve, reject) => {
        PER_BACKEND_FUNCS.canada.oldAlertQueue(async function () {
          console.log("fetchOldAlert", ref, forceBackupServer, isRawUrl);
          let url;
          if (!isRawUrl) {
            let [sender, id, sent] = ref.split(",");
            if (alerts[id]) {
              // already have this alert
              console.log("already have", id);
              return [false, false];
            }

            let msAgoSent = Date.now() - new Date(sent);
            if (msAgoSent > 86400000) { // 1 day
              console.log("not fetching", id, "because it is too old")
              return [false, false];
            }


            // yes, HTTP. SSL isn't supported.
            const xmlFilename = PER_BACKEND_FUNCS.canada.normalizeArchivePortion(`${sent}I${id}`);
            url = `http://capcp${forceBackupServer ? 2 : 1}.naad-adna.pelmorex.com/${sent.split("T")[0]}/${xmlFilename}.xml`;          
          } else {
            url = ref;
          }

          console.log("fetching", url);
          let text, json;
          try {
            let res = await fetch(url);
            text = await res.text();
            json = await xml2js.parseStringPromise(text);
          } catch (e) { reject(e); }
          resolve([parseAlertJson(json.alert), text]);
        });
      });
    }
  }
};
let alerts = {};

function parseKeyvalArray(arr) {
  if (!arr) return {};
  let obj = {};
  arr.forEach(keyVal => {
    let key = keyVal.valueName[0];
    let val = keyVal.value[0];
    obj[key] = val;
  });
  return obj;
}

function parseAlertJson(alert) {
  return {
    id: alert.identifier[0],
    sender: alert.sender[0],
    sent: +new Date(alert.sent[0]),
    status: alert.status[0],
    msgType: alert.msgType[0],
    source: alert.source ? alert.source[0] : null,
    scope: alert.scope[0],
    code: alert.code || [], // multiple are allowed
    references: alert.references ? alert.references[0] : null,
    class: "TODO",
    addresses: alert.addresses ? alert.addresses[0] : null,
    restriction: alert.restriction ? alert.restriction[0] : null,
    note: alert.note ? alert.note[0] : null,
    incidents: alert.incidents ? alert.incidents[0] : null,
    infos: (alert.info || []).map(i => ({
      language: i.language ? i.language[0] : "en-US", // the spec says it works this way
      category: i.category[0],
      event: i.event[0],
      responseType: i.responseType ? i.responseType[0] : null,
      urgency: i.urgency[0],
      severity: i.severity[0],
      certainty: i.certainty[0],
      audience: i.audience ? i.audience[0] : null,
      eventCodes: parseKeyvalArray(i.eventCode),
      effective: i.effective ? +new Date(i.effective[0]) : null,
      onset: i.onset ? +new Date(i.onset[0]) : null,
      expires: i.expires ? +new Date(i.expires[0]) : null,
      senderName: i.senderName ? +new Date(i.senderName[0]) : null,
      headline: i.headline ? i.headline[0] : null,
      description: i.description ? i.description[0] : null,
      instruction: i.instruction ? i.instruction[0] : null,
      web: i.web ? i.web[0] : null,
      contact: i.contact ? i.contact[0] : null,
      parameters: parseKeyvalArray(i.parameter),
      resources: (i.resources || []).map(r => ({
        resourceDesc: r.resourceDesc[0],
        mimeType: r.mimeType[0],
        size: r.size ? r.size[0] : null,
        uri: r.uri ? r.uri[0] : null,
        derefUri: r.derefUri ? r.derefUri[0] : null,
        digest: r.digest ? r.digest[0] : null,    
      })),
      areas: (i.area || []).map(area => ({
        areaDesc: area.areaDesc[0],
        polygon: area.polygon || [],
        circle: area.circle || [],
        geocodes: parseKeyvalArray(area.geocodes),
        altitude: area.altitude ? parseInt(area.altitude[0], 10) : null,
        ceiling: area.ceiling ? parseInt(area.ceiling[0], 10) : null
      })), // TODO
    })),
    signatures: [], // TODO
  };
}

function gotAlert(alert, rawXml, id, source, serverId) {
  console.log("gotAlert", id, "with source", source);

  if (alert.references) {
    console.log("got alert with references");
    alert.references.split(" ").forEach(async ref => {
      // all requests are sent out concurrently
      console.log("got ref", ref);
      let json, rawXml;
      try {
        [json, rawXml] = await PER_BACKEND_FUNCS[serverId].fetchOldAlert(ref);
      } catch (e) {
        console.log("got invalid ref", ref, e);
        return;
      }
      if (!json) return;
      //console.log(json);
      gotAlert(json, rawXml, json.id, "heartbeat-link", serverId);
    });
  }

  if (PER_BACKEND_FUNCS[serverId].isHeartbeat(alert)) {
    console.log("Alert is heartbeat, not storing");
    return;
  }
  let newAlert = false;
  if (!alerts[id]) {
    newAlert = true;
    alerts[id] = {
      alert,
      rawXml,
      confirmedFromMain: false,
      confirmedFromBackup: false,
      confirmedFromHeartbeatLink: false,
    };
  }
  if (source === "main") {
    alerts[id].confirmedFromMain = true;
  } else if (source === "backup") {
    alerts[id].confirmedFromBackup = true;
  } else if (source === "heartbeat-link") {
    alerts[id].confirmedFromHeartbeatLink = true;
  } else {
    throw new Error("invalid source " + source);
  }
  console.log("ID:", id);
  if (newAlert) {
    console.log("writing new alert to all sockets")
    sseCons.forEach(con => {
      con.res.socket.write("\n\ndata: " + JSON.stringify([alerts[id]]) + "\n\n")
    });
  }
  let data = JSON.stringify(alerts[id]);
  fs.writeFile(`${__dirname}/saved_alerts/${id}.json`, data, () => {
    console.log("Sucessfully wrote", id, "to disk");
  });
}

Object.keys(TCP_API_SERVERS).forEach(key => {
  alerts[key] = [];
  TCP_API_SERVERS[key].forEach(server => {
    const socket = new net.Socket();
    let pendingXml = "";
    let currentPSP = Promise.resolve();
    socket.on("data", async data => {
      try { await currentPSP; } catch (e) {}
      let dataStr = data.toString();
      pendingXml += dataStr;
      console.log(Date.now(), "got", dataStr.length, "bytes from", server.host + ":" + server.port);
      let alert;
      try {
        // creating the promise can fail, *and* awaiting it can fail
        currentPSP = xml2js.parseStringPromise(pendingXml);
        alert = await currentPSP;
      } catch (e) {
        console.log("Incomplete XML");
        return;
      }
      alert = alert.alert;
      const id = alert.identifier[0];
      let source = "main";
      if (server.host.includes("streaming2")) source = "backup";     
      gotAlert(parseAlertJson(alert), pendingXml, id, source, key);
      pendingXml = "";
    });
    socket.on("connect", () => {
      console.log("Streaming", key, "alerts from", server.host + ":" + server.port);
    });
    socket.connect({
      port: server.port,
      host: server.host,
    });
  });
});

const app = express();
let sseCons = [];
app.get("/api/:feedid/event-stream", (req, res) => {
  // this is called EventStream or Server-Sent Events
  const id = Math.random();
  res.status(200).set({
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
    "Content-Type": "text/event-stream",
    "Access-Control-Allow-Origin": "*",
    "Transfer-Encoding": "identity"
  });
  sseCons.push({
    res,
    id,
  });
  res.socket.on("close", function() {
    console.log("sse socket close");
    sseCons = sseCons.filter(con => con.id !== id);
  });
  res.write(": Connected\n\n");
  res.write("data: " + JSON.stringify(Object.values(alerts)) + "\n\n");
});
setInterval(() => {
  sseCons.forEach(con => {
    con.res.write(":");
  });
}, 8000);

app.get("/api/:feedid/search", (req, res) => {

});

app.listen(8080, () => console.log("Server started"));

// fetch old Canada alerts
(async () => {
  const now = new Date;
  const dateStr = `${now.getFullYear()}-${now.getMonth().toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
  const url = `http://capcp1.naad-adna.pelmorex.com/${dateStr}/`;
  const res = await fetch(url);
  const text = await res.text();
  const fileNames =
    text.match(/href=\"(.*?)\"/g).map(a => a.match(/\"(.*)\"/)[1]).filter(x => x.length > 15);
  const alertUrls = fileNames.map(x => `http://capcp1.naad-adna.pelmorex.com/${dateStr}/${x}`);
  alertUrls.forEach(url => PER_BACKEND_FUNCS.canada.fetchOldAlert(url, false, true));
  const savedAlertsFilenames = fs.readdirSync(`${__dirname}/saved_alerts`);
  savedAlertsFilenames.forEach(filename => {
    if (filename === ".gitkeep") return;
    console.log("Loading saved alert", filename);
    const file = fs.readFileSync(`${__dirname}/saved_alerts/${filename}`, "utf-8");
    const fileJson = JSON.parse(file);
    const id = fileJson.alert.id;
    alerts[id] = fileJson;
  });
})();
