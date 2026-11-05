"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/character-store.ts
var character_store_exports = {};
__export(character_store_exports, {
  BUILTIN_ID: () => BUILTIN_ID,
  CharacterStore: () => CharacterStore,
  PACK_LIMIT: () => PACK_LIMIT,
  knownScheme: () => knownScheme,
  nameIn: () => nameIn,
  safePath: () => safePath
});
module.exports = __toCommonJS(character_store_exports);
var import_node_crypto = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path2 = require("node:path");

// node_modules/fflate/esm/index.mjs
var import_module = require("module");
var require2 = (0, import_module.createRequire)("/");
var _a;
var Worker;
var isMarkedAsUntransferable;
try {
  _a = require2("worker_threads"), Worker = _a.Worker, isMarkedAsUntransferable = _a.isMarkedAsUntransferable;
} catch (e) {
}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i = 0; ; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0; i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0; i < c; ++i) {
    var _a2 = zh(data, o, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// src/upstream/packs.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var INLINE_TAG_MAX = 32;
var MANIFEST_FILE = "figure.json";
var MANIFEST_VERSION = 2;
var FIGURE_API = 2;
var MANIFEST_OLDEST = 2;
var FIGURE_API_OLDEST = 2;
var COO = "coo";
var PACK_SOUND_KINDS = ["move", "touch", "face", "snore"];
var AUDIO = /* @__PURE__ */ new Set([".ogg", ".mp3", ".wav"]);
var ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
var OPTION_ID = /^[a-z0-9]{1,24}$/;
var namesOf = (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const [k, s] of Object.entries(v)) if (typeof s === "string" && s.trim()) out[k] = s.trim();
  return Object.keys(out).length ? out : null;
};
var inside = (p) => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.split(/[\\/]/).includes("..") && !/^[a-z]+:/i.test(p);
var NAME_BREAK = /[,，、\s【】<>＜＞]/;
var WORD_KINDS = /* @__PURE__ */ new Set(["expression", "motion"]);
var SOUND_NAME = /^[a-z][a-zA-Z0-9-]{0,31}$/;
function readVocab(raw, skipped) {
  if (!Array.isArray(raw)) return "vocab \u5E94\u4E3A\u6570\u7EC4";
  const out = [];
  const taken = /* @__PURE__ */ new Set();
  for (const w of raw) {
    const id = w?.id;
    if (typeof id !== "string" || !ID.test(id)) return `vocab \u91CC\u6709\u4E0D\u5408\u6CD5\u7684 id:${JSON.stringify(id)}`;
    if (!WORD_KINDS.has(w.kind)) {
      skipped.push(`vocab.${id}.kind \u662F ${JSON.stringify(w.kind)},\u8FD9\u4E00\u7248\u4E0D\u8BA4\u8BC6,\u8FD9\u4E2A\u8BCD\u4E0D\u7ED9 bot \u7528`);
      continue;
    }
    const names = {};
    for (const [lang, list] of Object.entries(w.names ?? {})) {
      if (!Array.isArray(list)) return `vocab.${id}.names.${lang} \u5E94\u4E3A\u6570\u7EC4`;
      for (const n of list) {
        if (typeof n !== "string" || !n.trim() || n.length > INLINE_TAG_MAX || NAME_BREAK.test(n)) return `vocab.${id} \u7684\u540D\u5B57\u4E0D\u5408\u6CD5:${JSON.stringify(n)}`;
      }
      names[lang] = list;
    }
    for (const n of [id, ...Object.values(names).flat()]) {
      if (taken.has(n)) return `vocab \u91CC ${n} \u6307\u4E86\u4E0D\u6B62\u4E00\u4E2A\u8BCD`;
      taken.add(n);
    }
    const about = namesOf(w.about);
    if (!about) return `vocab.${id}.about \u7F3A\u5931`;
    if (typeof w.seconds !== "number" || !(w.seconds > 0) || !Number.isFinite(w.seconds)) return `vocab.${id}.seconds \u5E94\u4E3A\u6B63\u6570`;
    out.push({ id, kind: w.kind, names, about, seconds: w.seconds, ...w.lasting === true ? { lasting: true } : {} });
  }
  return out;
}
function readSounds(raw, dir, skipped) {
  if (raw === void 0) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "sounds \u5E94\u4E3A\u5BF9\u8C61";
  const out = {};
  for (const [name, d] of Object.entries(raw)) {
    if (!SOUND_NAME.test(name)) return `sounds \u91CC\u7684\u540D\u5B57\u4E0D\u5408\u6CD5:${JSON.stringify(name)}`;
    if (!inside(d?.file)) return `sounds.${name}.file \u5E94\u4E3A\u5F62\u8C61\u5305\u91CC\u7684\u6587\u4EF6`;
    if (d.volume !== void 0 && (typeof d.volume !== "number" || !(d.volume >= 0 && d.volume <= 1))) return `sounds.${name}.volume \u5E94\u4E3A 0\u20131`;
    if (!AUDIO.has((0, import_node_path.extname)(d.file).toLowerCase())) {
      skipped.push(`sounds.${name} \u7684 ${d.file} \u4E0D\u662F\u8FD9\u4E00\u7248\u653E\u5F97\u4E86\u7684 .ogg\u3001.mp3 \u6216 .wav,\u8FD9\u4E2A\u58F0\u97F3\u4E0D\u4F1A\u54CD`);
      continue;
    }
    if (!PACK_SOUND_KINDS.includes(d.kind)) {
      skipped.push(`sounds.${name}.kind \u662F ${JSON.stringify(d.kind)},\u8FD9\u4E00\u7248\u53EA\u8BA4 ${PACK_SOUND_KINDS.join("\u3001")},\u8FD9\u4E2A\u58F0\u97F3\u4E0D\u4F1A\u54CD`);
      continue;
    }
    if (!(0, import_node_fs.existsSync)((0, import_node_path.join)(dir, d.file))) {
      skipped.push(`sounds.${name} \u7684 ${d.file} \u4E0D\u5B58\u5728,\u8FD9\u4E2A\u58F0\u97F3\u4E0D\u4F1A\u54CD`);
      continue;
    }
    out[name] = { file: d.file, kind: d.kind, volume: d.volume ?? 1 };
  }
  return out;
}
function readManifest(dir, builtin = false, skipped = []) {
  const file = (0, import_node_path.join)(dir, MANIFEST_FILE);
  if (!(0, import_node_fs.existsSync)(file)) return `\u6CA1\u6709 ${MANIFEST_FILE}`;
  let raw;
  try {
    raw = JSON.parse((0, import_node_fs.readFileSync)(file, "utf8"));
  } catch (err2) {
    return `${MANIFEST_FILE} \u4E0D\u662F\u5408\u6CD5\u7684 JSON:${err2.message}`;
  }
  for (const [key, oldest, now] of [["manifest", MANIFEST_OLDEST, MANIFEST_VERSION], ["api", FIGURE_API_OLDEST, FIGURE_API]]) {
    const v = raw[key];
    if (typeof v !== "number" || !Number.isInteger(v)) return `${key} \u5E94\u4E3A\u6574\u6570,\u662F ${JSON.stringify(v)}`;
    if (v > now) return `${key} \u662F ${v},\u8FD9\u4E00\u7248\u53EA\u8BA4\u5230 ${now}:\u8981\u5148\u66F4\u65B0\u5E94\u7528`;
    if (v < oldest) return `${key} ${v} \u662F ${oldest} \u4E4B\u524D\u7684\u6D4B\u8BD5\u683C\u5F0F,\u8BFB\u4E0D\u4E86`;
  }
  if (typeof raw.id !== "string" || !ID.test(raw.id) || raw.id === COO && !builtin) return `id \u4E0D\u5408\u6CD5:${JSON.stringify(raw.id)}`;
  const name = namesOf(raw.name), about = namesOf(raw.about);
  if (!name) return "name \u7F3A\u5931";
  if (!about) return "about \u7F3A\u5931";
  if (!inside(raw.entry) || typeof raw.export !== "string" || !raw.export) return "entry \u6216 export \u4E0D\u5408\u6CD5";
  if (raw.model !== void 0 && !inside(raw.model)) return "model \u8DEF\u5F84\u4E0D\u5408\u6CD5";
  if (raw.thumb !== void 0 && !inside(raw.thumb)) return "thumb \u8DEF\u5F84\u4E0D\u5408\u6CD5";
  const axes = [];
  for (const a of Array.isArray(raw.axes) ? raw.axes : []) {
    const an = namesOf(a?.name);
    if (typeof a?.id !== "string" || !ID.test(a.id) || !an || !Array.isArray(a.options) || !a.options.length) return `axes \u91CC\u6709\u4E0D\u5408\u6CD5\u7684\u4E00\u9879:${JSON.stringify(a?.id)}`;
    const options = [];
    for (const o of a.options) {
      const on = namesOf(o?.name);
      if (typeof o?.id !== "string" || !OPTION_ID.test(o.id) || !on || o.thumb !== void 0 && !inside(o.thumb)) return `axes.${a.id} \u91CC\u6709\u4E0D\u5408\u6CD5\u7684\u9009\u9879:${JSON.stringify(o?.id)}`;
      options.push({ id: o.id, name: on, ...o.thumb ? { thumb: o.thumb } : {}, ...typeof o.accent === "string" ? { accent: o.accent } : {} });
    }
    axes.push({ id: a.id, name: an, options });
  }
  const presets = [];
  for (const p of Array.isArray(raw.presets) ? raw.presets : []) {
    const pick = p?.pick;
    if (typeof p?.id !== "string" || !ID.test(p.id) || !pick || typeof pick !== "object") return `presets \u91CC\u6709\u4E0D\u5408\u6CD5\u7684\u4E00\u9879:${JSON.stringify(p?.id)}`;
    for (const a of axes) if (!a.options.some((o) => o.id === pick[a.id])) return `presets.${p.id} \u6CA1\u6709\u9009 ${a.id} \u7684\u9009\u9879`;
    if (p.thumb !== void 0 && !inside(p.thumb)) return `presets.${p.id}.thumb \u8DEF\u5F84\u4E0D\u5408\u6CD5`;
    presets.push({
      id: p.id,
      pick: Object.fromEntries(axes.map((a) => [a.id, pick[a.id]])),
      ...namesOf(p.name) ? { name: namesOf(p.name) } : {},
      ...p.thumb ? { thumb: p.thumb } : {},
      ...typeof p.accent === "string" ? { accent: p.accent } : {},
      ...p.console && typeof p.console === "object" ? { console: p.console } : {}
    });
  }
  const vocab = readVocab(raw.vocab, skipped);
  if (typeof vocab === "string") return vocab;
  const sounds = readSounds(raw.sounds, dir, skipped);
  if (typeof sounds === "string") return sounds;
  const can = raw.can ?? {};
  if (can.walk !== void 0 && typeof can.walk !== "boolean") skipped.push(`can.walk \u662F ${JSON.stringify(can.walk)},\u8FD9\u4E00\u7248\u4E0D\u8BA4\u8BC6,\u6309\u4F1A\u8D70\u5904\u7406`);
  return {
    manifest: MANIFEST_VERSION,
    api: raw.api,
    id: raw.id,
    version: typeof raw.version === "string" ? raw.version : "0.0.0",
    name,
    about,
    entry: raw.entry,
    export: raw.export,
    axes,
    presets,
    vocab,
    sounds,
    can: { walk: can.walk !== false },
    ...typeof raw.author === "string" ? { author: raw.author } : {},
    ...typeof raw.license === "string" ? { license: raw.license } : {},
    ...Array.isArray(raw.credits) ? { credits: raw.credits } : {},
    ...raw.model ? { model: raw.model } : {},
    ...raw.thumb ? { thumb: raw.thumb } : {}
  };
}
function nameIn(n, language = "zh") {
  return n[language] ?? n.zh ?? Object.values(n)[0] ?? "";
}

// src/character-store.ts
var BUILTIN_ID = "whale";
var PACK_LIMIT = 128 * 1024 * 1024;
var validId = (id) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(id) && !["whale", "coo"].includes(id);
var validHash = (hash) => /^[a-f0-9]{64}$/.test(hash);
var safePath = (path) => !!path && path.length <= 512 && !/[\\:\x00-\x1f?#]/.test(path) && path.split("/").every((part) => !!part && part !== "." && part !== "..");
function knownScheme(pack, value = "") {
  if (pack.presets.some((p) => p.id === value)) return value;
  const parts = value.split("-");
  return pack.axes.map((a, i) => a.options.some((o) => o.id === parts[i]) ? parts[i] : a.options[0].id).join("-");
}
var CharacterStore = class {
  constructor(directory, builtinDirectory) {
    this.directory = directory;
    this.builtinDirectory = builtinDirectory;
  }
  async atomic(file, value) {
    await (0, import_promises.mkdir)(this.directory, { recursive: true });
    const temp = `${file}.${(0, import_node_crypto.randomUUID)()}.tmp`;
    try {
      await (0, import_promises.writeFile)(temp, value, { mode: 384 });
      await (0, import_promises.rename)(temp, file);
    } finally {
      await (0, import_promises.rm)(temp, { force: true });
    }
  }
  manifest(directory, builtin = false) {
    const manifest = readManifest(directory, builtin);
    if (typeof manifest === "string") throw new Error(manifest);
    return manifest;
  }
  async load(id) {
    if (id === BUILTIN_ID) return { ...this.manifest(this.builtinDirectory, true), base: "./upstream/whale/", builtin: true, revision: "builtin" };
    if (!validId(id)) throw new Error("\u65E0\u6548\u7684\u89D2\u8272 id");
    const index = (0, import_node_path2.join)(this.directory, `${id}.json`);
    if ((await (0, import_promises.stat)(index)).size > 256) throw new Error("\u89D2\u8272\u7D22\u5F15\u65E0\u6548");
    const { revision } = JSON.parse(await (0, import_promises.readFile)(index, "utf8"));
    if (typeof revision !== "string" || !validHash(revision)) throw new Error("\u89D2\u8272\u7D22\u5F15\u65E0\u6548\uFF0C\u8BF7\u91CD\u65B0\u5BFC\u5165 API 2 \u89D2\u8272\u5305");
    const manifest = this.manifest((0, import_node_path2.join)(this.directory, `${id}-${revision}`));
    if (manifest.id !== id) throw new Error("\u89D2\u8272\u5305\u4E0E\u7D22\u5F15\u4E0D\u5339\u914D");
    return { ...manifest, base: `./packs/${id}/${revision}/`, builtin: false, revision };
  }
  async list() {
    await (0, import_promises.mkdir)(this.directory, { recursive: true });
    const characters = [await this.load(BUILTIN_ID)], problems = [];
    for (const file of await (0, import_promises.readdir)(this.directory)) {
      if (!file.endsWith(".json") || !validId(file.slice(0, -5))) continue;
      try {
        characters.push(await this.load(file.slice(0, -5)));
      } catch (error) {
        problems.push(`\u65E0\u6CD5\u8BFB\u53D6\u89D2\u8272 ${file.slice(0, -5)}\uFF1A${error instanceof Error ? error.message : "\u7D22\u5F15\u9519\u8BEF"}`);
      }
    }
    let selected = BUILTIN_ID;
    const schemes = {};
    try {
      const file = (0, import_node_path2.join)(this.directory, ".selection.json");
      if ((await (0, import_promises.stat)(file)).size > 16 * 1024) throw new Error("\u9009\u62E9\u8BB0\u5F55\u8FC7\u5927");
      const saved = JSON.parse(await (0, import_promises.readFile)(file, "utf8"));
      if (characters.some((p) => p.id === saved.id)) selected = saved.id;
      for (const pack of characters) schemes[pack.id] = knownScheme(pack, typeof saved.schemes?.[pack.id] === "string" ? saved.schemes[pack.id] : "");
    } catch (error) {
      if (error.code !== "ENOENT") problems.push("\u89D2\u8272\u9009\u62E9\u8BB0\u5F55\u635F\u574F\uFF0C\u5DF2\u6062\u590D\u5927\u80A5\u9C7C");
    }
    for (const pack of characters) schemes[pack.id] ??= knownScheme(pack);
    return { characters, selected, schemes, problems };
  }
  async import(bytes) {
    if (bytes.length > PACK_LIMIT) throw new Error("\u89D2\u8272\u5305\u4E0D\u80FD\u8D85\u8FC7 128 MiB");
    let total = 0, count = 0;
    const files = unzipSync(bytes, { filter(entry) {
      if (++count > 2048 || !safePath(entry.name.replace(/\/$/, ""))) throw new Error("\u89D2\u8272\u5305\u6587\u4EF6\u8DEF\u5F84\u6216\u6570\u91CF\u4E0D\u5408\u6CD5");
      if (entry.originalSize > 16 * 1024 * 1024 || (total += entry.originalSize) > PACK_LIMIT) throw new Error("\u89E3\u538B\u540E\u7684\u89D2\u8272\u5305\u8FC7\u5927");
      return !entry.name.endsWith("/");
    } });
    const roots = Object.keys(files).filter((p) => (p === "figure.json" || p.endsWith("/figure.json")) && p.split("/").length <= 4);
    if (roots.length !== 1) throw new Error("\u8BF7\u5BFC\u5165\u5305\u542B\u4E00\u4E2A figure.json\uFF08API 2\uFF09\u7684 ZIP\uFF1B\u65E7 .dshpet \u5DF2\u4E0D\u518D\u652F\u6301");
    const prefix = roots[0].slice(0, -"figure.json".length);
    if (files[roots[0]].length > 256 * 1024) throw new Error("figure.json \u8FC7\u5927");
    await (0, import_promises.mkdir)(this.directory, { recursive: true });
    const staging = await (0, import_promises.mkdtemp)((0, import_node_path2.join)(this.directory, ".import-"));
    try {
      let actual = 0;
      for (const [path, data] of Object.entries(files)) {
        if (!path.startsWith(prefix)) continue;
        const relative = path.slice(prefix.length);
        if (!safePath(relative) || data.length > 16 * 1024 * 1024 || (actual += data.length) > PACK_LIMIT) throw new Error("\u89D2\u8272\u5305\u6587\u4EF6\u4E0D\u5408\u6CD5\u6216\u8FC7\u5927");
        const full = (0, import_node_path2.join)(staging, relative);
        await (0, import_promises.mkdir)((0, import_node_path2.join)(full, ".."), { recursive: true });
        await (0, import_promises.writeFile)(full, data, { mode: 384 });
      }
      const manifest = this.manifest(staging);
      if (!validId(manifest.id)) throw new Error("\u8BE5 id \u662F\u5185\u7F6E\u89D2\u8272\u7684\u4FDD\u7559 id");
      for (const file of [manifest.entry, manifest.model, manifest.thumb].filter((v) => !!v)) {
        if (!safePath(file) || !(await (0, import_promises.stat)((0, import_node_path2.join)(staging, file))).isFile()) throw new Error(`\u89D2\u8272\u6587\u4EF6\u7F3A\u5931\uFF1A${file}`);
      }
      if (!/\.(m?js)$/.test(manifest.entry)) throw new Error("entry \u5FC5\u987B\u662F JavaScript \u6A21\u5757");
      if (manifest.model) JSON.parse(await (0, import_promises.readFile)((0, import_node_path2.join)(staging, manifest.model), "utf8"));
      const revision = (0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex");
      const destination = (0, import_node_path2.join)(this.directory, `${manifest.id}-${revision}`);
      try {
        await (0, import_promises.stat)(destination);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await (0, import_promises.rename)(staging, destination);
      }
      await this.atomic((0, import_node_path2.join)(this.directory, `${manifest.id}.json`), JSON.stringify({ revision }));
      return { ...await this.list(), importedId: manifest.id };
    } finally {
      await (0, import_promises.rm)(staging, { recursive: true, force: true });
    }
  }
  async select(id, scheme) {
    const pack = await this.load(id), library = await this.list();
    library.schemes[id] = knownScheme(pack, scheme ?? library.schemes[id]);
    await this.atomic((0, import_node_path2.join)(this.directory, ".selection.json"), JSON.stringify({ id, schemes: library.schemes }));
  }
  async remove(id) {
    if (!validId(id)) throw new Error("\u4E0D\u80FD\u5220\u9664\u5185\u7F6E\u89D2\u8272\u6216\u65E0\u6548\u7684\u89D2\u8272 id");
    await this.load(id);
    await (0, import_promises.rm)((0, import_node_path2.join)(this.directory, `${id}.json`));
    for (const file of await (0, import_promises.readdir)(this.directory)) {
      if (file.startsWith(`${id}-`) && validHash(file.slice(id.length + 1))) await (0, import_promises.rm)((0, import_node_path2.join)(this.directory, file), { recursive: true, force: true });
    }
    const library = await this.list();
    await this.select(library.selected);
    return library;
  }
  async asset(id, revision, path) {
    if (!validId(id) || !validHash(revision) || !safePath(path)) throw new Error("\u65E0\u6548\u7684\u89D2\u8272\u8D44\u6E90");
    return (0, import_promises.readFile)((0, import_node_path2.join)(this.directory, `${id}-${revision}`, path));
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BUILTIN_ID,
  CharacterStore,
  PACK_LIMIT,
  knownScheme,
  nameIn,
  safePath
});
