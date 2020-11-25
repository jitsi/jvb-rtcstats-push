const fetch = require("node-fetch")
const { v4: uuidv4 } = require('uuid');

// TODO: take as argument
const jvbUrl = "http://127.0.0.1:4443/debug";

class App {
    constructor() {
        // Map conference ID to state about that conference
        this.conferenceStates = {};
    }

    start() {
        this.fetchTask = setInterval(async () => {
            console.log("Fetching data");
            const json = await fetchData();
            const confIds = getConferenceIds(json);
            this.checkForAddedOrRemovedConferences(confIds);
            confIds.forEach(confId => {
                const currentConfEps = json["conferences"][confId]["endpoints"];
                this.checkForAddedOrRemovedEndpoints(confId, currentConfEps);
            });
        }, 5000);
    }

    checkForAddedOrRemovedConferences(currentConfIds) {
        const newConfIds = currentConfIds.filter(id => !(id in this.conferenceStates));
        const removedConfIds = Object.keys(this.conferenceStates).filter(id => currentConfIds.indexOf(id) === -1)
        newConfIds.forEach(newConfId => {
            const dumpId = uuidv4();
            const confState = {
                dumpId,
                // TODO: use a set?
                endpoints: []
            }
            this.conferenceStates[newConfId] = confState;
            sendIdentityMessage(confState);
        });
        removedConfIds.forEach(removedConfId => {
            // TODO: send dump close message
            delete this.conferenceStates[removedConfId];
        });
    }

    checkForAddedOrRemovedEndpoints(confId, currentConfEndpoints) {
        const confState = this.conferenceStates[confId];
        const knownConfEps = confState["endpoints"];
        const epStatsIds = Object.keys(currentConfEndpoints)
            .map(epId => currentConfEndpoints[epId]);
        const newEndpoints = epStatsIds.filter(epStatsId => knownConfEps.indexOf(epStatsId) === -1);
        if (newEndpoints.length > 0) {
            confState["endpoints"].push(...newEndpoints);
            sendIdentityMessage(confState);
        }
    }
}

const app = new App();

app.start();

/**
 * Given the data retrieved from the JVB REST API,
 * extract all of the conference IDs
 * @param jvbJson
 */
function getConferenceIds(jvbJson) {
    return Object.keys(jvbJson.conferences);
}

async function fetchData() {
    try {
        const response = await fetch(jvbUrl)
        return await response.json();
    } catch (e) {
        console.log("Error retrieving data: ", e);
        return null
    }
}

function sendIdentityMessage(/*websocket client,*/ state) {
    // This is a bit awkward: we keep the dumpId in the conference state,
    // but we need to set it as an explicit field of the message.
    const {dumpId, ...metadata} = state;
    const msg = {
        type: "identity",
        dumpId,
        data: JSON.stringify(metadata)
    }
    console.log("created identity message: ", JSON.stringify(msg));
}

function sendCloseMessage(/* websocket client,*/dumpId) {
    const msg = {
        type: "close",
        dumpId
    }
    console.log("created close message: ", JSON.stringify(msg));
}

