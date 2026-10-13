#!/usr/bin/env bash
set -Eeuo pipefail
# Host-only setup. No application environment, network, database or model credentials enter this one-shot container.
key=/opt/aimine/.credentials/price-relay/signing.pem
[[ -f $key && ! -L $key ]]
image=$(docker inspect --format '{{.Image}}' amp-worker-1)
docker volume create --label com.docker.compose.project=amp --label com.docker.compose.volume=price-relay-keys amp_price-relay-keys >/dev/null
docker run --rm --network none --user 0 --mount type=volume,source=amp_price-relay-keys,target=/keys --mount type=bind,source="$key",target=/incoming.pem,readonly "$image" node --input-type=module -e '
import {readFileSync,existsSync,writeFileSync,chmodSync,chownSync} from "node:fs";
import {createPrivateKey,createPublicKey} from "node:crypto";
const source=readFileSync("/incoming.pem");
const key=createPrivateKey(source);
if(key.asymmetricKeyType!=="ed25519")throw new Error("Wrong signing key type");
const target="/keys/signing.pem";
const publicKey=(value)=>createPublicKey(createPrivateKey(value)).export({type:"spki",format:"der"});
if(existsSync(target)) { if(!publicKey(readFileSync(target)).equals(publicKey(source)))throw new Error("Existing signing key differs; explicit rotation required"); }
else writeFileSync(target,source,{flag:"wx",mode:0o600});
chmodSync(target,0o600);chownSync(target,1000,1000);
console.log("Signing key installed in the dedicated worker volume");
'
