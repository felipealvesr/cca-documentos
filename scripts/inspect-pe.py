"""Read-only PE resource/import inspection; no binary execution."""
from pathlib import Path
import struct
import sys

def inspect(file):
    b = Path(file).read_bytes()
    pe = struct.unpack_from('<I', b, 0x3c)[0]
    sections_n = struct.unpack_from('<H', b, pe + 6)[0]
    optional_size = struct.unpack_from('<H', b, pe + 20)[0]
    optional = pe + 24
    data_dir = optional + (112 if struct.unpack_from('<H',b,optional)[0] == 0x20b else 96)
    sections = []
    for i in range(sections_n):
        off = optional + optional_size + i * 40
        size, addr, raw_size, raw = struct.unpack_from('<IIII', b, off + 8)
        sections.append((addr, max(size,raw_size), raw))
    def pos(rva):
        return next(raw + rva - addr for addr,size,raw in sections if addr <= rva < addr + size)
    imports = []
    rva = struct.unpack_from('<I',b,data_dir + 8)[0]
    if rva:
        off = pos(rva)
        while any(b[off:off+20]):
            name = pos(struct.unpack_from('<I',b,off+12)[0]); imports.append(b[name:b.index(b'\x00',name)].decode()); off += 20
    icons = []
    rva = struct.unpack_from('<I',b,data_dir + 16)[0]
    if rva:
        base = pos(rva)
        def walk(offset, ids):
            count = sum(struct.unpack_from('<HH',b,base+offset+12))
            for i in range(count):
                name,target = struct.unpack_from('<II',b,base+offset+16+i*8)
                identifier = name if not name & 0x80000000 else 'name'
                if target & 0x80000000: walk(target & 0x7fffffff, ids+[identifier])
                elif ids and ids[0] == 14:
                    ptr,size = struct.unpack_from('<II',b,base+target)
                    group = pos(ptr); n = struct.unpack_from('<H',b,group+4)[0]
                    for j in range(n):
                        p = group+6+j*14
                        icons.append((b[p] or 256,b[p+1] or 256))
        walk(0,[])
    return {'file': str(file), 'imports': imports, 'iconSizes': sorted(set(icons))}
if __name__ == '__main__':
    import json
    for arg in sys.argv[1:]: print(json.dumps(inspect(arg)))
