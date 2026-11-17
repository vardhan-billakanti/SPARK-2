import { execSync } from 'node:child_process';

const list = execSync('tasklist /FO CSV /NH').toString();
const spotifyLines = list.split(/\r?\n/).filter(line => /spotify/i.test(line));
console.log('Tasklist Spotify lines:', spotifyLines);
