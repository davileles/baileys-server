// suppress-noise.cjs
// Carregado via NODE_OPTIONS=--require ./suppress-noise.cjs
// Filtra dumps de criptografia do Baileys que causam rate limit no Railway (500 logs/s)
// Precisa ser .cjs pois --require não suporta ES Modules

const NOISE = [
  'privKey: <Buffer',
  'pubKey: <Buffer',
  'rootKey: <Buffer',
  'lastRemoteEphemeralKey: <Buffer',
  'remoteIdentityKey: <Buffer',
  'baseKey: <Buffer',
  'Closing session: SessionEntry',
  'Removing old closed session',
  'currentRatchet:',
  'ephemeralKeyPair:',
  '_chains:',
  'chainKey: [Object]',
  'messageKeys: {}',
  'registrationId:',
  'baseKeyType:',
  'pendingPreKey:',
  'signedKeyId:',
  'preKeyId:',
  'previousCounter:',
  'indexInfo:',
];

const _write = process.stdout.write.bind(process.stdout);
const _ewrite = process.stderr.write.bind(process.stderr);

function isNoise(chunk) {
  const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  return NOISE.some(kw => str.includes(kw));
}

process.stdout.write = function(chunk, encoding, cb) {
  if (isNoise(chunk)) {
    if (typeof cb === 'function') cb();
    return true;
  }
  return _write(chunk, encoding, cb);
};

process.stderr.write = function(chunk, encoding, cb) {
  if (isNoise(chunk)) {
    if (typeof cb === 'function') cb();
    return true;
  }
  return _ewrite(chunk, encoding, cb);
};
