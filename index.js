#!/usr/bin/env node

/** @typedef {import('pear-interface')} */ 
import Hyperswarm from 'hyperswarm';   
import b4a from 'b4a';                
import crypto from 'hypercore-crypto';
import readline from 'bare-readline'; 
import tty from 'bare-tty';           
import fs from 'bare-fs'; 

const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB
const receivedFiles = {};

const { teardown, config, updates } = Pear;
const key = config.args.pop();       
const shouldCreateSwarm = !key;      
const swarm = new Hyperswarm();

teardown(() => swarm.destroy());
// updates(() => Pear.reload());

const rl = readline.createInterface({
  input: new tty.ReadStream(0),
  output: new tty.WriteStream(1)
});

swarm.on('connection', peer => {
  const name = b4a.toString(peer.remotePublicKey, 'hex').substr(0, 6);
  console.log(`[info] New peer joined: ${name}`);
  peer.on('data', data => handleIncomingFile(data, name));
  peer.on('error', e => console.log(`Connection error: ${e}`));
});

swarm.on('update', () => {
  console.log(`[info] Number of connections is now ${swarm.connections.size}`);
});

if (shouldCreateSwarm) {
  await createFileSharingRoom();
} else {
  await joinFileSharingRoom(key);
}

rl.input.setMode(tty.constants.MODE_RAW);
rl.on('line', async line => {
  if (line.startsWith('/send')) {
    const filePath = line.split(' ')[1];
    if (filePath) {
      await sendFile(filePath);
    } else {
      console.log(`[error] Usage: /send <file-path>`);
    }
  } else {
    console.log(`[error] Invalid command. Use /send <file-path> to send a file.`);
  }
  rl.prompt();
});
rl.prompt();

rl.on('close', () => {
  process.kill(process.pid, 'SIGINT');
});

async function createFileSharingRoom() {
  const topicBuffer = crypto.randomBytes(32);
  await joinSwarm(topicBuffer);
  const topic = b4a.toString(topicBuffer, 'hex');
  console.log(`[info] Created new file-sharing room: ${topic}`);
}
async function joinFileSharingRoom(topicStr) {
  const topicBuffer = b4a.from(topicStr, 'hex');
  await joinSwarm(topicBuffer);
  console.log(`[info] Joined file-sharing room`);
}
async function joinSwarm(topicBuffer) {
  const discovery = swarm.join(topicBuffer, { client: true, server: true });
  await discovery.flushed();
}
async function sendFile(filePath) {
  let payload;
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = filePath.split('/').pop();
    const totalChunks = Math.ceil(fileBuffer.length/CHUNK_SIZE);

    for(let i=0;i<totalChunks;i++){
      const chunk = fileBuffer.slice(i*CHUNK_SIZE, (i+1) * CHUNK_SIZE);
      payload = JSON.stringify({
        fileName,
        chunk: chunk.toString('base64'),
        index: i,
        total: totalChunks,
      });
    }

    for (const peer of [...swarm.connections]) {
      peer.write(b4a.from(payload));
    }
    console.log(`[info] File "${fileName}" sent to all peers.`);
  } catch (error) {
    console.error(`[error] Failed to send file: ${error.message}`);
  }
}

function handleIncomingFile(data, peerName) {
  try {
    const { fileName, chunk, index, total } = JSON.parse(data.toString());
    const savePath = `./received_${fileName}`;

    if (!receivedFiles[fileName]) {
      receivedFiles[fileName] = {
        writeStream: fs.createWriteStream(savePath),
        total,
        received: 0,
        completed: false,
      };
    }

    const fileInfo = receivedFiles[fileName];

    if (!fileInfo.completed) {
      const chunkBuffer = b4a.from(chunk, 'base64');

      // Write the chunk directly to the file
      fileInfo.writeStream.write(chunkBuffer, () => {
        fileInfo.received++;
        console.log(
          `[info] Received chunk ${index + 1}/${total} of file "${fileName}" from ${peerName}.`
        );

        if (fileInfo.received === fileInfo.total) {
          fileInfo.writeStream.end();
          fileInfo.completed = true;
          console.log(
            `[info] File "${fileName}" received completely from ${peerName}. Saved as "${savePath}".`
          );
          delete receivedFiles[fileName];
        }
      });
    }
  } catch (error) {
    console.error(`[error] Failed to handle incoming file: ${error.message}`);
  }
}

