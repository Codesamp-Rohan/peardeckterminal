#!/usr/bin/env node

import { Command } from 'commander';
import Hyperswarm from 'hyperswarm';
import b4a from 'b4a';
import crypto from 'hypercore-crypto';
import fs from 'fs';
import process from 'process';

const program = new Command();
const CHUNK_SIZE = 1024 * 1024; // 1MB
const receivedFiles = {};

const swarm = new Hyperswarm();
let currentTopic;
let interactiveModeActive = false;

// Teardown on exit
process.on('SIGINT', async () => {
  await swarm.destroy();
  process.exit();
});

swarm.on('connection', (peer) => {
  const name = b4a.toString(peer.remotePublicKey, 'hex').substr(0, 6);
  console.log(`[info] New peer joined: ${name}`);
  peer.on('data', (data) => handleIncomingFile(data, name));
  peer.on('error', (e) => console.log(`Connection error: ${e}`));
  startInteractiveMode();
});

swarm.on('update', () => {
  console.log(`[info] Number of connections is now ${swarm.connections.size}`);
});

async function createFileSharingRoom() {
  const topicBuffer = crypto.randomBytes(32);
  await joinSwarm(topicBuffer);
  currentTopic = b4a.toString(topicBuffer, 'hex');
  console.log(`[info] Created new file-sharing room: ${currentTopic}`);
  startInteractiveMode();
}

async function joinFileSharingRoom(topicStr) {
  const topicBuffer = b4a.from(topicStr, 'hex');
  await joinSwarm(topicBuffer);
  currentTopic = topicStr;
  console.log(`[info] Joined file-sharing room`);
  startInteractiveMode();
}

async function joinSwarm(topicBuffer) {
  const discovery = swarm.join(topicBuffer, { client: true, server: true });
  await discovery.flushed();
}

async function sendFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`[error] File does not exist: ${filePath}`);
      return;
    }

    const fileBuffer = fs.readFileSync(filePath);
    const fileName = filePath.split('/').pop();
    const totalChunks = Math.ceil(fileBuffer.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const chunk = fileBuffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const payload = JSON.stringify({
        fileName,
        chunk: chunk.toString('base64'),
        index: i,
        total: totalChunks,
      });

      for (const peer of [...swarm.connections]) {
        peer.write(b4a.from(payload));
      }
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
        received: [],
        completed: false,
      };
    }

    const fileInfo = receivedFiles[fileName];
    if (!fileInfo.completed) {
      const chunkBuffer = b4a.from(chunk, 'base64');
      fileInfo.received[index] = chunkBuffer;

      console.log(`[info] Received chunk ${index + 1}/${total} of file "${fileName}" from ${peerName}.`);

      // Check if all chunks are received
      if (fileInfo.received.filter(Boolean).length === fileInfo.total) {
        for (const bufferedChunk of fileInfo.received) {
          fileInfo.writeStream.write(bufferedChunk);
        }
        fileInfo.writeStream.end();
        fileInfo.completed = true;

        console.log(`[info] File "${fileName}" received completely from ${peerName}. Saved as "${savePath}".`);
        delete receivedFiles[fileName];
      }
    }
  } catch (error) {
    console.error(`[error] Failed to handle incoming file: ${error.message}`);
  }
}

function startInteractiveMode() {
  if (interactiveModeActive) return;
  interactiveModeActive = true;

  console.log(`[info] Interactive mode enabled. Use /send <file-path> to send files.`);

  process.stdin.on('data', async (data) => {
    const input = data.toString().trim();
    if (input.startsWith('/send')) {
      const filePath = input.split(' ')[1];
      if (filePath) {
        await sendFile(filePath);
      } else {
        console.log(`[error] Usage: /send <file-path>`);
      }
    } else {
      console.log(`[error] Invalid command. Use /send <file-path> to send a file.`);
    }
  });
}

async function showHelp() {
  console.log(`
Usage:
  peardeckterminal --create                  Create a file-sharing room
  peardeckterminal --join <seed/topic>       Join an existing room
  peardeckterminal --help                    Show this help message
  /send <file-path>                          Send a file to all connected peers
`);
}

program
  .name('peardeckterminal')
  .description('A P2P file-sharing tool using Hyperswarm')
  .version('1.2.1');

program
  .option('--create', 'Create a file-sharing room')
  .option('--join <topic>', 'Join a file-sharing room using a topic')
  .action(async (options) => {
    if (options.create) {
      await createFileSharingRoom();
    } else if (options.join) {
      await joinFileSharingRoom(options.join);
    } else {
      await showHelp();
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  showHelp();
}
