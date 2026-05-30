#!/usr/bin/env python3
"""
Gavl ↔ Chia bridge.

Wraps the real Chia primitives so the Node side can shell out for genuine
proofs:
  - chiavdf : Wesolowski VDF (proof of TIME) over a 1024-bit class group
  - chiapos : proof of SPACE (plot / prove / verify)

Protocol: invoked as `python chia_proofs.py '<json-request>'`; writes a single
JSON object to stdout. All library chatter (chiapos plotting logs, etc.) is
redirected to stderr so stdout carries only the JSON response.

Requests:
  {"cmd":"vdf_prove","challenge":"<hex>","iters":N} -> {"proof","output"}
  {"cmd":"vdf_verify","challenge":"<hex>","iters":N,"proof":"<hex>"} -> {"ok"}
  {"cmd":"pos_plot","k":K,"plotId":"<hex>","dir":"<path>"} -> {"path","id","k"}
  {"cmd":"pos_prove","path":"<path>","challenge":"<hex>"} -> {"proof"|null,"quality","k","id"}
  {"cmd":"pos_verify","plotId":"<hex>","k":K,"challenge":"<hex>","proof":"<hex>"} -> {"quality"|null}
"""

import sys, os, json

VDF_SIZE = 1024
# Chia's default class-group element (the generator), 100 bytes: 0x08 flag + zeros.
VDF_X = bytes([0x08]) + bytes(99)


def vdf_prove(req):
    import chiavdf
    challenge = bytes.fromhex(req["challenge"])
    iters = int(req["iters"])
    proof = chiavdf.prove(challenge, VDF_X, VDF_SIZE, iters, "")
    return {"proof": proof.hex(), "output": proof[:100].hex()}


def vdf_verify(req):
    import chiavdf
    try:
        challenge = bytes.fromhex(req["challenge"])
        proof = bytes.fromhex(req["proof"])
        disc = chiavdf.create_discriminant(challenge, VDF_SIZE)
        ok = chiavdf.verify_n_wesolowski(disc, VDF_X, proof, int(req["iters"]), VDF_SIZE, 0)
        return {"ok": bool(ok)}
    except Exception:
        return {"ok": False}


def pos_plot(req):
    import chiapos
    k = int(req["k"])
    plot_id = bytes.fromhex(req["plotId"])
    memo = (plot_id + plot_id)[:48]
    dirpath = req["dir"]
    os.makedirs(dirpath, exist_ok=True)
    fname = f"gavl-{req['plotId'][:16]}-k{k}.plot"
    buckets = 16 if k <= 19 else 32
    stripe = 2000 if k <= 19 else 4000
    chiapos.DiskPlotter().create_plot_disk(dirpath, dirpath, dirpath, fname, k, memo, plot_id, 256, buckets, stripe, 2, False)
    return {"path": os.path.join(dirpath, fname), "id": req["plotId"], "k": k}


def pos_prove(req):
    import chiapos
    ch = bytes.fromhex(req["challenge"])
    pr = chiapos.DiskProver(req["path"])
    quals = pr.get_qualities_for_challenge(ch)
    if not quals:
        return {"proof": None}  # this plot does not qualify for this challenge (normal)
    proof = pr.get_full_proof(ch, 0)
    # Return the VERIFIER's quality (not quals[0]) so prover and verifier agree
    # byte-for-byte — the anchor layer keys required-iters on this exact value.
    q = chiapos.Verifier().validate_proof(pr.get_id(), pr.get_size(), ch, proof)
    return {"proof": proof.hex(), "quality": q.hex(), "k": pr.get_size(), "id": pr.get_id().hex()}


def pos_verify(req):
    import chiapos
    try:
        q = chiapos.Verifier().validate_proof(bytes.fromhex(req["plotId"]), int(req["k"]), bytes.fromhex(req["challenge"]), bytes.fromhex(req["proof"]))
        return {"quality": q.hex() if q is not None else None}
    except Exception:
        return {"quality": None}


HANDLERS = {"vdf_prove": vdf_prove, "vdf_verify": vdf_verify, "pos_plot": pos_plot, "pos_prove": pos_prove, "pos_verify": pos_verify}


def main():
    # Redirect fd 1 → fd 2 so any native library output can't pollute the JSON on stdout.
    real_stdout = os.dup(1)
    os.dup2(2, 1)
    try:
        req = json.loads(sys.argv[1])
        handler = HANDLERS.get(req.get("cmd"))
        out = handler(req) if handler else {"error": f"unknown cmd {req.get('cmd')}"}
    except Exception as e:
        out = {"error": str(e)}
    finally:
        os.dup2(real_stdout, 1)
        os.close(real_stdout)
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
