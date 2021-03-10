### Running

The pusher requires 2 pieces of information: the address of the JVB's REST API (to be queried) and the address of the
RTCStats server (to which data should be pushed).  This information can be provided in 2 ways:

1) Command line arguments: `node app.js --jvb-address http://127.0.0.1:8081 --rtcstats-server ws://127.0.0.1:3001`
2) Environment variables: `JVB_ADDRESS="http://127.0.0.1:8081" RTCSTATS_SERVER="ws://127.0.0.1:3001" node app.js`
