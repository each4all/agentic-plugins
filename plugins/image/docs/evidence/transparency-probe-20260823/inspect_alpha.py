#!/usr/bin/env python3
"""Report a PNG's real per-pixel alpha, not just whether the channel exists."""
import sys, zlib, struct

def chunks(b):
    assert b[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    o = 8
    while o < len(b):
        ln = struct.unpack('>I', b[o:o+4])[0]
        typ = b[o+4:o+8]
        yield typ, b[o+8:o+8+ln]
        o += 12 + ln

def inspect(path):
    b = open(path, 'rb').read()
    ihdr = idat = None; trns = False
    for typ, data in chunks(b):
        if typ == b'IHDR': ihdr = data
        elif typ == b'IDAT': idat = (idat or b'') + data
        elif typ == b'tRNS': trns = True
    w, h, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', ihdr)
    names = {0:'gray',2:'rgb',3:'palette',4:'gray+alpha',6:'rgba'}
    out = {'file': path, 'w': w, 'h': h, 'depth': depth,
           'color_type': f'{ctype} ({names.get(ctype,"?")})', 'tRNS': trns,
           'has_alpha_channel': ctype in (4, 6)}
    if ctype not in (4, 6) or depth != 8 or interlace != 0:
        out['alpha_verdict'] = 'no per-pixel alpha channel' if ctype not in (4,6) else 'unsupported depth/interlace'
        return out
    nch = 4 if ctype == 6 else 2
    raw = zlib.decompress(idat)
    stride = w * nch
    prev = bytearray(stride); rows = []
    o = 0
    for _ in range(h):
        f = raw[o]; o += 1
        line = bytearray(raw[o:o+stride]); o += stride
        for i in range(stride):
            a = line[i-nch] if i >= nch else 0
            bb = prev[i]; c = prev[i-nch] if i >= nch else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + bb) & 255
            elif f == 3: line[i] = (line[i] + (a + bb) // 2) & 255
            elif f == 4:
                p = a + bb - c
                pa, pb, pc = abs(p-a), abs(p-bb), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (bb if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        rows.append(line); prev = line
    alphas = [row[i] for row in rows for i in range(nch-1, stride, nch)]
    total = len(alphas)
    fully_transparent = sum(1 for a in alphas if a == 0)
    fully_opaque = sum(1 for a in alphas if a == 255)
    partial = total - fully_transparent - fully_opaque
    out.update({
        'pixels': total,
        'alpha_min': min(alphas), 'alpha_max': max(alphas),
        'fully_transparent_pct': round(100*fully_transparent/total, 2),
        'fully_opaque_pct': round(100*fully_opaque/total, 2),
        'partial_pct': round(100*partial/total, 2),
        'alpha_verdict': ('REAL TRANSPARENCY' if fully_transparent > 0 or partial > 0
                          else 'alpha channel present but every pixel is opaque'),
    })
    return out

if __name__ == '__main__':
    import json
    for p in sys.argv[1:]:
        try: print(json.dumps(inspect(p), indent=1))
        except Exception as e: print(json.dumps({'file': p, 'error': str(e)}))
