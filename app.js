const fetch = require("node-fetch")
const { v4: uuidv4 } = require('uuid');

// TODO: take as argument
const url = "http://127.0.0.1:4443/debug";

class App {
    constructor() {
        // Map conference ID to dump ID
        this.conferenceIdToDumpId = {};
    }

    start() {
        this.fetchTask = setInterval(async () => {
            console.log("Fetching data");
            const json = await fetchData();
            const confIds = getConferenceIds(json);
            this.checkForAddedOrRemovedConferences(confIds);
        }, 5000);
    }

    checkForAddedOrRemovedConferences(currentConfIds) {
        const newConfIds = currentConfIds.filter(id => !(id in this.conferenceIdToDumpId));
        const removedConfIds = Object.keys(this.conferenceIdToDumpId).filter(id => currentConfIds.indexOf(id) === -1)
        newConfIds.forEach(newConfId => {
            // TODO: send initial identity message
            this.conferenceIdToDumpId[newConfId] = uuidv4();
        });
        removedConfIds.forEach(removedConfId => {
            // TODO: send dump close message
            delete this.conferenceIdToDumpId[removedConfId];
        });
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
        const response = await fetch(url)
        return await response.json();
    } catch (e) {
        console.log("Error retrieving data: ", e);
        return null
    }
}

