;(function(){'use strict';window.requestAnimationFrame || (window.requestAnimationFrame = window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame);
function ScreenAdapter(a, c) {
  function d(a) {
    a = a.toString(16);
    return "#" + Array(7 - a.length).join("0") + a;
  }
  function e() {
    for (var a = 0;a < B;a++) {
      A[a] && (H.text_update_row(a), A[a] = 0);
    }
    this.timer();
  }
  function f() {
    u < v && (m.putImageData(p, 0, 0, 0, u / C >> 2, C, ((v - u) / C >> 2) + 1), u = 1E7, v = 0);
    this.timer();
  }
  function g(a, c, d) {
    c = "" + (1 === c ? "" : " scaleX(" + c + ")") + (1 === d ? "" : " scaleY(" + d + ")");
    a.style.webkitTransform = a.style.MozTransform = c;
  }
  console.assert(a, "1st argument must be a DOM container");
  for (var k = a.getElementsByTagName("canvas")[0], m = k.getContext("2d"), l = k.nextElementSibling || k.previousElementSibling, n = document.createElement("div"), p, q, r, s, t, x = 1, D = 1, C, u = 0, v = 0, A, F = !1, w, z, B, H = this, I = new Uint16Array([199, 252, 233, 226, 228, 224, 229, 231, 234, 235, 232, 239, 238, 236, 196, 197, 201, 230, 198, 244, 246, 242, 251, 249, 255, 214, 220, 162, 163, 165, 8359, 402, 225, 237, 243, 250, 241, 209, 170, 186, 191, 8976, 172, 189, 188, 161, 171, 187, 
  9617, 9618, 9619, 9474, 9508, 9569, 9570, 9558, 9557, 9571, 9553, 9559, 9565, 9564, 9563, 9488, 9492, 9524, 9516, 9500, 9472, 9532, 9566, 9567, 9562, 9556, 9577, 9574, 9568, 9552, 9580, 9575, 9576, 9572, 9573, 9561, 9560, 9554, 9555, 9579, 9578, 9496, 9484, 9608, 9604, 9612, 9616, 9600, 945, 223, 915, 960, 931, 963, 181, 964, 934, 920, 937, 948, 8734, 966, 949, 8745, 8801, 177, 8805, 8804, 8992, 8993, 247, 8776, 176, 8729, 183, 8730, 8319, 178, 9632, 160]), J = new Uint16Array([32, 9786, 9787, 
  9829, 9830, 9827, 9824, 8226, 9688, 9675, 9689, 9794, 9792, 9834, 9835, 9788, 9658, 9668, 8597, 8252, 182, 167, 9644, 8616, 8593, 8595, 8594, 8592, 8735, 8596, 9650, 9660]), G = [], E, y = 0;256 > y;y++) {
    127 < y ? E = I[y - 128] : 32 > y ? E = J[y] : E = y, G[y] = String.fromCharCode(E);
  }
  m.imageSmoothingEnabled = !1;
  m.mozImageSmoothingEnabled = !1;
  m.webkitImageSmoothingEnabled = !1;
  n.style.position = "absolute";
  n.style.backgroundColor = "#ccc";
  n.style.width = "7px";
  n.style.display = "inline-block";
  l.style.display = "block";
  k.style.display = "none";
  this.bus = c;
  c.register("screen-set-mode", function(a) {
    this.set_mode(a);
  }, this);
  c.register("screen-put-pixel-linear", function(a) {
    this.put_pixel_linear(a[0], a[1]);
  }, this);
  c.register("screen-put-pixel-linear32", function(a) {
    this.put_pixel_linear32(a[0], a[1]);
  }, this);
  c.register("screen-put-char", function(a) {
    this.put_char(a[0], a[1], a[2], a[3], a[4]);
  }, this);
  c.register("screen-update-cursor", function(a) {
    this.update_cursor(a[0], a[1]);
  }, this);
  c.register("screen-update-cursor-scanline", function(a) {
    this.update_cursor_scanline(a[0], a[1]);
  }, this);
  c.register("screen-set-size-text", function(a) {
    this.set_size_text(a[0], a[1]);
  }, this);
  c.register("screen-set-size-graphical", function(a) {
    this.set_size_graphical(a[0], a[1]);
  }, this);
  this.init = function() {
    this.set_size_text(80, 25);
    this.timer();
  };
  this.make_screenshot = function() {
    try {
      window.open(k.toDataURL());
    } catch (a) {
    }
  };
  this.put_char = function(a, c, d, f, e) {
    a < B && c < z && (c = 3 * (a * z + c), w[c] = d, w[c + 1] = f, w[c + 2] = e, A[a] = 1);
  };
  this.timer = function() {
    requestAnimationFrame(F ? f : e);
  };
  e = e.bind(this);
  f = f.bind(this);
  this.put_pixel_linear = function(a, c) {
    a >= q.length || (u = a < u ? a : u, v = a > v ? a : v, q[a + 1 ^ 3] = c);
  };
  this.put_pixel_linear32 = function(a, c) {
    u = a < u ? a : u;
    v = a > v ? a : v;
    r[a >> 2] = 4278190080 | c >> 16 & 255 | c << 16 | c & 65280;
  };
  this.destroy = function() {
  };
  this.set_mode = function(a) {
    (F = a) ? (l.style.display = "none", k.style.display = "block") : (l.style.display = "block", k.style.display = "none");
  };
  this.set_size_text = function(a, c) {
    if (a !== z && c !== B) {
      A = new Int8Array(c);
      w = new Int32Array(a * c * 3);
      z = a;
      for (B = c;l.childNodes.length > c;) {
        l.removeChild(l.firstChild);
      }
      for (;l.childNodes.length < c;) {
        l.appendChild(document.createElement("div"));
      }
      for (var d = 0;d < c;d++) {
        this.text_update_row(d);
      }
    }
  };
  this.set_size_graphical = function(a, c) {
    k.style.display = "block";
    k.width = a;
    k.height = c;
    p = m.createImageData(a, c);
    q = new Uint8Array(p.data.buffer);
    r = new Int32Array(p.data.buffer);
    for (var d = 3;d < q.length;d += 4) {
      q[d] = 255;
    }
    C = a;
  };
  this.set_scale = function(a, c) {
    x = a;
    D = c;
    g(k, x, D);
    g(l, x, D);
  };
  this.set_scale(x, D);
  this.update_cursor_scanline = function(a, c) {
    a & 32 ? n.style.display = "none" : (n.style.display = "inline", n.style.height = Math.min(15, c - a) + "px", n.style.marginTop = Math.min(15, a) + "px");
  };
  this.update_cursor = function(a, c) {
    if (a !== s || c !== t) {
      A[a] = 1, A[s] = 1, s = a, t = c;
    }
  };
  this.text_update_row = function(a) {
    var c = 3 * a * z, f, e, g, k, m, p;
    f = l.childNodes[a];
    for (g = document.createDocumentFragment();f.firstChild;) {
      f.removeChild(f.firstChild);
    }
    for (var q = 0;q < z;) {
      e = document.createElement("span");
      k = w[c + 1];
      m = w[c + 2];
      e.style.backgroundColor = d(k);
      e.style.color = d(m);
      for (p = "";q < z && w[c + 1] === k && w[c + 2] === m;) {
        if (p += G[w[c]], q++, c += 3, a === s) {
          if (q === t) {
            break;
          } else {
            if (q === t + 1) {
              g.appendChild(n);
              break;
            }
          }
        }
      }
      e.textContent = p;
      g.appendChild(e);
    }
    f.appendChild(g);
  };
  this.init();
}
;function Virtio9p(a) {
  this.fs = a;
  this.SendReply = function() {
  };
  this.configspace = [6, 0, 104, 111, 115, 116, 57, 112];
  this.msize = this.BLOCKSIZE = 8192;
  this.replybuffer = new Uint8Array(2 * this.msize);
  this.replybuffersize = 0;
  this.fid2inode = [];
  this.fidtype = [];
  this._state_skip = ["fs", "SendReply"];
}
Virtio9p.prototype.BuildReply = function(a, c, d) {
  Marshall(["w", "b", "h"], [d + 7, a + 1, c], this.replybuffer, 0);
  this.replybuffersize = d + 7;
};
Virtio9p.prototype.SendError = function(a, c) {
  var d = Marshall(["w"], [c], this.replybuffer, 7);
  this.BuildReply(6, a, d);
};
Virtio9p.prototype.ReceiveRequest = function(a, c) {
  var d = Unmarshall2(["w", "b", "h"], c), e = d[1], f = d[2];
  switch(e) {
    case 8:
      var d = 1234567, g = [16914839];
      g[1] = this.BLOCKSIZE;
      g[2] = Math.floor(1073741824 / g[1]);
      g[3] = g[2] - Math.floor(d / g[1]);
      g[4] = g[2] - Math.floor(d / g[1]);
      g[5] = this.fs.inodes.length;
      g[6] = 1048576;
      g[7] = 0;
      g[8] = 256;
      d = Marshall("wwddddddw".split(""), g, this.replybuffer, 7);
      this.BuildReply(e, f, d);
      this.SendReply(a);
      break;
    case 112:
    ;
    case 12:
      var g = Unmarshall2(["w", "w"], c), k = g[0], m = g[1], l = this.fs.GetInode(this.fid2inode[k]);
      g[0] = l.qid;
      g[1] = this.msize - 24;
      Marshall(["Q", "w"], g, this.replybuffer, 7);
      this.BuildReply(e, f, 17);
      d = this.fs.OpenInode(this.fid2inode[k]);
      this.fs.AddEvent(this.fid2inode[k], function() {
        g[0] = l.qid;
        g[1] = this.msize - 24;
        Marshall(["Q", "w"], g, this.replybuffer, 7);
        this.BuildReply(e, f, 17);
        this.SendReply(a);
      }.bind(this));
      break;
    case 70:
      var g = Unmarshall2(["w", "w", "s"], c), m = g[0], k = g[1], d = g[2], l = this.fs.CreateInode(), n = this.fs.GetInode(this.fid2inode[k]), p = this.fs.inodedata[this.fid2inode[k]];
      l.mode = n.mode;
      l.size = n.size;
      l.symlink = n.symlink;
      for (var q = this.fs.inodedata[this.fs.inodes.length] = new Uint8Array(l.size), n = 0;n < l.size;n++) {
        q[n] = p[n];
      }
      l.name = d;
      l.parentid = this.fid2inode[m];
      this.fs.PushInode(l);
      this.BuildReply(e, f, 0);
      this.SendReply(a);
      break;
    case 16:
      g = Unmarshall2(["w", "s", "s", "w"], c);
      k = g[0];
      d = g[1];
      n = g[3];
      d = this.fs.CreateSymlink(d, this.fid2inode[k], g[2]);
      l = this.fs.GetInode(d);
      l.uid = n;
      l.gid = n;
      Marshall(["Q"], [l.qid], this.replybuffer, 7);
      this.BuildReply(e, f, 13);
      this.SendReply(a);
      break;
    case 18:
      g = Unmarshall2("wswwww".split(""), c);
      k = g[0];
      d = g[1];
      m = g[2];
      d = this.fs.CreateNode(d, this.fid2inode[k], g[3], g[4]);
      l = this.fs.GetInode(d);
      l.mode = m;
      l.uid = n;
      l.gid = n;
      Marshall(["Q"], [l.qid], this.replybuffer, 7);
      this.BuildReply(e, f, 13);
      this.SendReply(a);
      break;
    case 22:
      g = Unmarshall2(["w"], c);
      k = g[0];
      l = this.fs.GetInode(this.fid2inode[k]);
      d = Marshall(["s"], [l.symlink], this.replybuffer, 7);
      this.BuildReply(e, f, d);
      this.SendReply(a);
      break;
    case 72:
      g = Unmarshall2(["w", "s", "w", "w"], c);
      k = g[0];
      d = g[1];
      m = g[2];
      n = g[3];
      d = this.fs.CreateDirectory(d, this.fid2inode[k]);
      l = this.fs.GetInode(d);
      l.mode = m | S_IFDIR;
      l.uid = n;
      l.gid = n;
      Marshall(["Q"], [l.qid], this.replybuffer, 7);
      this.BuildReply(e, f, 13);
      this.SendReply(a);
      break;
    case 14:
      g = Unmarshall2(["w", "s", "w", "w", "w"], c);
      k = g[0];
      d = g[1];
      m = g[3];
      n = g[4];
      d = this.fs.CreateFile(d, this.fid2inode[k]);
      this.fid2inode[k] = d;
      this.fidtype[k] = 1;
      l = this.fs.GetInode(d);
      l.uid = n;
      l.gid = n;
      l.mode = m;
      Marshall(["Q", "w"], [l.qid, this.msize - 24], this.replybuffer, 7);
      this.BuildReply(e, f, 17);
      this.SendReply(a);
      break;
    case 52:
      Marshall(["w"], [0], this.replybuffer, 7);
      this.BuildReply(e, f, 1);
      this.SendReply(a);
      break;
    case 24:
      g = Unmarshall2(["w", "d"], c);
      k = g[0];
      l = this.fs.GetInode(this.fid2inode[k]);
      g[0] |= 4096;
      g[0] = g[1];
      g[1] = l.qid;
      g[2] = l.mode;
      g[3] = l.uid;
      g[4] = l.gid;
      g[5] = 1;
      g[6] = l.major << 8 | l.minor;
      g[7] = l.size;
      g[8] = l.size;
      g[9] = Math.floor(l.size / this.BLOCKSIZE + 1);
      g[10] = l.atime;
      g[11] = 0;
      g[12] = l.mtime;
      g[13] = 0;
      g[14] = l.ctime;
      g[15] = 0;
      g[16] = 0;
      g[17] = 0;
      g[18] = 0;
      g[19] = 0;
      Marshall("dQwwwddddddddddddddd".split(""), g, this.replybuffer, 7);
      this.BuildReply(e, f, 153);
      this.SendReply(a);
      break;
    case 26:
      g = Unmarshall2("wwwwwddddd".split(""), c);
      k = g[0];
      l = this.fs.GetInode(this.fid2inode[k]);
      g[1] & 1 && (l.mode = g[2]);
      g[1] & 2 && (l.uid = g[3]);
      g[1] & 4 && (l.gid = g[4]);
      g[1] & 128 && (l.atime = g[6]);
      g[1] & 256 && (l.atime = g[8]);
      g[1] & 16 && (l.atime = Math.floor((new Date).getTime() / 1E3));
      g[1] & 32 && (l.mtime = Math.floor((new Date).getTime() / 1E3));
      g[1] & 64 && (l.ctime = Math.floor((new Date).getTime() / 1E3));
      g[1] & 8 && this.fs.ChangeSize(this.fid2inode[k], g[5]);
      this.BuildReply(e, f, 0);
      this.SendReply(a);
      break;
    case 50:
      g = Unmarshall2(["w", "d"], c);
      k = g[0];
      this.BuildReply(e, f, 0);
      this.SendReply(a);
      break;
    case 40:
    ;
    case 116:
      var g = Unmarshall2(["w", "d", "w"], c), k = g[0], r = g[1], s = g[2], l = this.fs.GetInode(this.fid2inode[k]);
      if (2 == this.fidtype[k]) {
        l.caps.length < r + s && (s = l.caps.length - r);
        for (n = 0;n < s;n++) {
          this.replybuffer[11 + n] = l.caps[r + n];
        }
        Marshall(["w"], [s], this.replybuffer, 7);
        this.BuildReply(e, f, 4 + s);
        this.SendReply(a);
      } else {
        this.fs.OpenInode(this.fid2inode[k]), this.fs.AddEvent(this.fid2inode[k], function() {
          l.size < r + s && (s = l.size - r);
          var c = this.fs.inodedata[this.fid2inode[k]];
          if (c) {
            for (var d = 0;d < s;d++) {
              this.replybuffer[11 + d] = c[r + d];
            }
          }
          Marshall(["w"], [s], this.replybuffer, 7);
          this.BuildReply(e, f, 4 + s);
          this.SendReply(a);
        }.bind(this));
      }
      break;
    case 118:
      g = Unmarshall2(["w", "d", "w"], c);
      k = g[0];
      r = g[1];
      s = g[2];
      this.fs.Write(this.fid2inode[k], r, s, c);
      Marshall(["w"], [s], this.replybuffer, 7);
      this.BuildReply(e, f, 4);
      this.SendReply(a);
      break;
    case 74:
      g = Unmarshall2(["w", "s", "w", "s"], c);
      d = this.fs.Rename(this.fid2inode[g[0]], g[1], this.fid2inode[g[2]], g[3]);
      if (0 == d) {
        this.SendError(f, 2);
        this.SendReply(a);
        break;
      }
      this.BuildReply(e, f, 0);
      this.SendReply(a);
      break;
    case 76:
      g = Unmarshall2(["w", "s", "w"], c);
      n = g[0];
      d = g[1];
      k = this.fs.Search(this.fid2inode[n], d);
      if (-1 == k) {
        this.SendError(f, 2);
        this.SendReply(a);
        break;
      }
      d = this.fs.Unlink(k);
      if (!d) {
        this.SendError(f, 39);
        this.SendReply(a);
        break;
      }
      this.BuildReply(k, f, 0);
      this.SendReply(a);
      break;
    case 100:
      this.msize = Unmarshall2(["w", "s"], c)[0];
      d = Marshall(["w", "s"], [this.msize, "9P2000.L"], this.replybuffer, 7);
      this.BuildReply(e, f, d);
      this.SendReply(a);
      break;
    case 104:
      g = Unmarshall2(["w", "w", "s", "s"], c);
      k = g[0];
      this.fid2inode[k] = 0;
      this.fidtype[k] = 1;
      l = this.fs.GetInode(this.fid2inode[k]);
      Marshall(["Q"], [l.qid], this.replybuffer, 7);
      this.BuildReply(e, f, 13);
      this.SendReply(a);
      break;
    case 108:
      g = Unmarshall2(["h"], c);
      this.BuildReply(e, f, 0);
      this.SendReply(a);
      break;
    case 110:
      g = Unmarshall2(["w", "w", "h"], c);
      k = g[0];
      m = g[1];
      p = g[2];
      if (0 == p) {
        this.fid2inode[m] = this.fid2inode[k];
        Marshall(["h"], [0], this.replybuffer, 7);
        this.BuildReply(e, f, 2);
        this.SendReply(a);
        break;
      }
      d = [];
      for (n = 0;n < p;n++) {
        d.push("s");
      }
      for (var q = Unmarshall2(d, c), d = this.fid2inode[k], r = 9, t = 0, n = 0;n < p;n++) {
        d = this.fs.Search(d, q[n]);
        if (-1 == d) {
          break;
        }
        r += Marshall(["Q"], [this.fs.inodes[d].qid], this.replybuffer, r);
        t++;
        this.fid2inode[m] = d;
        this.fidtype[m] = 1;
      }
      Marshall(["h"], [t], this.replybuffer, 7);
      this.BuildReply(e, f, r - 7);
      this.SendReply(a);
      break;
    case 120:
      g = Unmarshall2(["w"], c);
      0 <= this.fid2inode[g[0]] && (this.fs.CloseInode(this.fid2inode[g[0]]), this.fid2inode[g[0]] = -1, this.fidtype[g[0]] = -1);
      this.BuildReply(e, f, 0);
      this.SendReply(a);
      break;
    case 32:
      this.SendError(f, 524);
      this.SendReply(a);
      break;
    case 30:
      g = Unmarshall2(["w", "w", "s"], c), k = g[0], n = g[1], d = g[2], this.fid2inode[n] = this.fid2inode[k], this.fidtype[n] = -1, m = 0, "security.capability" == d && (m = this.fs.PrepareCAPs(this.fid2inode[k]), this.fidtype[n] = 2), Marshall(["d"], [m], this.replybuffer, 7), this.BuildReply(e, f, 8), this.SendReply(a);
  }
};
function CPU() {
  this.memory_size = 0;
  this.segment_is_null = [];
  this.segment_offsets = [];
  this.segment_limits = [];
  this.tlb_data = new Int32Array(1048576);
  this.tlb_info = new Uint8Array(1048576);
  this.tlb_info_global = new Uint8Array(1048576);
  this.protected_mode = !1;
  this.gdtr_offset = this.gdtr_size = this.idtr_offset = this.idtr_size = 0;
  this.page_fault = !1;
  this.page_size_extensions = this.cpl = this.cr4 = this.cr3 = this.cr2 = this.cr0 = 0;
  this.in_hlt = this.address_size_32 = this.stack_size_32 = this.operand_size_32 = this.is_32 = !1;
  this.devices = {vga:{timer:function() {
  }, destroy:function() {
  }}, ps2:{timer:function() {
  }, destroy:function() {
  }}};
  this.tsc_offset = this.last_result = this.last_add_result = this.last_op_size = this.last_op2 = this.last_op1 = this.flags_changed = this.flags = this.repeat_string_prefix = this.sysenter_eip = this.sysenter_esp = this.sysenter_cs = this.eip_phys = this.last_virt_eip = 0;
  this.regv = this.reg16;
  this.reg_vdi = this.reg_vsi = this.reg_vcx = 0;
  this.table = [];
  this.table0F = [];
  this.paging = !1;
  this.previous_ip = this.instruction_pointer = 0;
  this.bios = {main:null, vga:null};
  this.timestamp_counter = 0;
  this.reg32s = new Int32Array(8);
  this.reg32 = new Uint32Array(this.reg32s.buffer);
  this.reg16s = new Int16Array(this.reg32s.buffer);
  this.reg16 = new Uint16Array(this.reg32s.buffer);
  this.reg8s = new Int8Array(this.reg32s.buffer);
  this.reg8 = new Uint8Array(this.reg32s.buffer);
  this.sreg = new Uint16Array(8);
  this.dreg = new Int32Array(8);
  this.stack_reg = this.reg16;
  this.reg_vbp = this.reg_vsp = 0;
  this.memory = null;
  this.segment_prefix = -1;
  this.last_instr_jump = !1;
  this.fpu = this.io = void 0;
  "use strict";
  (function(a) {
    var c = {};
    a.debug = c;
    c.step_mode = !1;
    c.ops = void 0;
    c.all_ops = [];
    c.trace_all = !1;
    c.show = function(a) {
      if ("undefined" !== typeof document) {
        var c = document.getElementById("log");
        if (c) {
          c.textContent += a + "\n";
          c.style.display = "block";
          c.scrollTop = 1E9;
          return;
        }
      }
      console.log(c);
    };
    c.init = function() {
    };
    c.dump_regs = function() {
    };
    c.dump_instructions = function() {
    };
    c.get_instructions = function() {
    };
    c.dump_regs_short = function() {
    };
    c.dump_stack = function() {
    };
    c.dump_page_directory = function() {
    };
    c.dump_gdt_ldt = function() {
    };
    c.dump_idt = function() {
    };
    c.get_memory_dump = function() {
    };
    c.memory_hex_dump = function() {
    };
    c.used_memory_dump = function() {
    };
    c.step = function() {
    };
    c.run_until = function() {
    };
    c.debugger = function() {
    };
    c.unimpl = function(a) {
      a = "Unimplemented" + (a ? ": " + a : "");
      c.show(a);
      c.show("Execution stopped");
      return a;
    };
    c.logop = function() {
    };
  })(this);
  this._state_restore();
}
CPU.prototype._state_restore = function() {
  this.reg32 = new Uint32Array(this.reg32s.buffer);
  this.reg16s = new Int16Array(this.reg32s.buffer);
  this.reg16 = new Uint16Array(this.reg32s.buffer);
  this.reg8s = new Int8Array(this.reg32s.buffer);
  this.reg8 = new Uint8Array(this.reg32s.buffer);
  this.update_address_size();
  this.update_operand_size();
  this.stack_size_32 ? this.stack_reg = this.reg32s : this.stack_reg = this.reg16;
  this.full_clear_tlb();
  this.timestamp_counter = 0;
  this.tsc_offset = v86.microtick();
  this._state_skip = [this.bios, this.debug, this.table16, this.table32, this.table0F_16, this.table0F_32, this.tlb_data, this.tlb_info, this.tlb_info_global];
};
"use strict";
(function() {
  CPU.prototype.modrm_table16 = Array(192);
  CPU.prototype.modrm_table32 = Array(192);
  CPU.prototype.sib_table = Array(256);
  CPU.prototype.modrm_table16[0] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[6] + a.reg16[12] & 65535) | 0;
  };
  CPU.prototype.modrm_table16[64] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[6] + a.reg16[12] + a.read_imm8s() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[128] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[6] + a.reg16[12] + a.read_imm16() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[1] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[6] + a.reg16[14] & 65535) | 0;
  };
  CPU.prototype.modrm_table16[65] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[6] + a.reg16[14] + a.read_imm8s() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[129] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[6] + a.reg16[14] + a.read_imm16() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[2] = function(a) {
    return a.get_seg_prefix_ss() + (a.reg16[10] + a.reg16[12] & 65535) | 0;
  };
  CPU.prototype.modrm_table16[66] = function(a) {
    return a.get_seg_prefix_ss() + (a.reg16[10] + a.reg16[12] + a.read_imm8s() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[130] = function(a) {
    return a.get_seg_prefix_ss() + (a.reg16[10] + a.reg16[12] + a.read_imm16() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[3] = function(a) {
    return a.get_seg_prefix_ss() + (a.reg16[10] + a.reg16[14] & 65535) | 0;
  };
  CPU.prototype.modrm_table16[67] = function(a) {
    return a.get_seg_prefix_ss() + (a.reg16[10] + a.reg16[14] + a.read_imm8s() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[131] = function(a) {
    return a.get_seg_prefix_ss() + (a.reg16[10] + a.reg16[14] + a.read_imm16() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[4] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[12] & 65535) | 0;
  };
  CPU.prototype.modrm_table16[68] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[12] + a.read_imm8s() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[132] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[12] + a.read_imm16() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[5] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[14] & 65535) | 0;
  };
  CPU.prototype.modrm_table16[69] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[14] + a.read_imm8s() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[133] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[14] + a.read_imm16() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[6] = function(a) {
    return a.get_seg_prefix_ss() + (a.reg16[10] & 65535) | 0;
  };
  CPU.prototype.modrm_table16[70] = function(a) {
    return a.get_seg_prefix_ss() + (a.reg16[10] + a.read_imm8s() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[134] = function(a) {
    return a.get_seg_prefix_ss() + (a.reg16[10] + a.read_imm16() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[7] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[6] & 65535) | 0;
  };
  CPU.prototype.modrm_table16[71] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[6] + a.read_imm8s() & 65535) | 0;
  };
  CPU.prototype.modrm_table16[135] = function(a) {
    return a.get_seg_prefix_ds() + (a.reg16[6] + a.read_imm16() & 65535) | 0;
  };
  CPU.prototype.modrm_table32[0] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.modrm_table32[64] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[0] + a.read_imm8s() | 0;
  };
  CPU.prototype.modrm_table32[128] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[0] + a.read_imm32s() | 0;
  };
  CPU.prototype.modrm_table32[1] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.modrm_table32[65] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[1] + a.read_imm8s() | 0;
  };
  CPU.prototype.modrm_table32[129] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[1] + a.read_imm32s() | 0;
  };
  CPU.prototype.modrm_table32[2] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.modrm_table32[66] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[2] + a.read_imm8s() | 0;
  };
  CPU.prototype.modrm_table32[130] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[2] + a.read_imm32s() | 0;
  };
  CPU.prototype.modrm_table32[3] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.modrm_table32[67] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[3] + a.read_imm8s() | 0;
  };
  CPU.prototype.modrm_table32[131] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[3] + a.read_imm32s() | 0;
  };
  CPU.prototype.modrm_table32[4] = function(a) {
    return a.sib_table[a.read_imm8()](a, !1) | 0;
  };
  CPU.prototype.modrm_table32[68] = function(a) {
    return a.sib_table[a.read_imm8()](a, !1) + a.read_imm8s() | 0;
  };
  CPU.prototype.modrm_table32[132] = function(a) {
    return a.sib_table[a.read_imm8()](a, !1) + a.read_imm32s() | 0;
  };
  CPU.prototype.modrm_table32[5] = function(a) {
    return a.get_seg_prefix_ss() + a.reg32s[5] | 0;
  };
  CPU.prototype.modrm_table32[69] = function(a) {
    return a.get_seg_prefix_ss() + a.reg32s[5] + a.read_imm8s() | 0;
  };
  CPU.prototype.modrm_table32[133] = function(a) {
    return a.get_seg_prefix_ss() + a.reg32s[5] + a.read_imm32s() | 0;
  };
  CPU.prototype.modrm_table32[6] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.modrm_table32[70] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[6] + a.read_imm8s() | 0;
  };
  CPU.prototype.modrm_table32[134] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[6] + a.read_imm32s() | 0;
  };
  CPU.prototype.modrm_table32[7] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.modrm_table32[71] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[7] + a.read_imm8s() | 0;
  };
  CPU.prototype.modrm_table32[135] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[7] + a.read_imm32s() | 0;
  };
  CPU.prototype.modrm_table16[6] = function(a) {
    return a.get_seg_prefix_ds() + a.read_imm16() | 0;
  };
  CPU.prototype.modrm_table32[5] = function(a) {
    return a.get_seg_prefix_ds() + a.read_imm32s() | 0;
  };
  CPU.prototype.modrm_table32[4] = function(a) {
    return a.sib_table[a.read_imm8()](a, !1) | 0;
  };
  CPU.prototype.modrm_table32[68] = function(a) {
    return a.sib_table[a.read_imm8()](a, !0) + a.read_imm8s() | 0;
  };
  CPU.prototype.modrm_table32[132] = function(a) {
    return a.sib_table[a.read_imm8()](a, !0) + a.read_imm32s() | 0;
  };
  for (var a = 0;8 > a;a++) {
    for (var c = 0;3 > c;c++) {
      for (var d = a | c << 6, e = 1;8 > e;e++) {
        CPU.prototype.modrm_table32[d | e << 3] = CPU.prototype.modrm_table32[d], CPU.prototype.modrm_table16[d | e << 3] = CPU.prototype.modrm_table16[d];
      }
    }
  }
  CPU.prototype.sib_table[0] = function(a) {
    return a.reg32s[0] + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[1] = function(a) {
    return a.reg32s[0] + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[2] = function(a) {
    return a.reg32s[0] + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[3] = function(a) {
    return a.reg32s[0] + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[4] = function(a) {
    return a.reg32s[0] + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[5] = function(a, c) {
    return a.reg32s[0] + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[6] = function(a) {
    return a.reg32s[0] + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[7] = function(a) {
    return a.reg32s[0] + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[64] = function(a) {
    return(a.reg32s[0] << 1) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[65] = function(a) {
    return(a.reg32s[0] << 1) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[66] = function(a) {
    return(a.reg32s[0] << 1) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[67] = function(a) {
    return(a.reg32s[0] << 1) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[68] = function(a) {
    return(a.reg32s[0] << 1) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[69] = function(a, c) {
    return(a.reg32s[0] << 1) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[70] = function(a) {
    return(a.reg32s[0] << 1) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[71] = function(a) {
    return(a.reg32s[0] << 1) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[128] = function(a) {
    return(a.reg32s[0] << 2) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[129] = function(a) {
    return(a.reg32s[0] << 2) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[130] = function(a) {
    return(a.reg32s[0] << 2) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[131] = function(a) {
    return(a.reg32s[0] << 2) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[132] = function(a) {
    return(a.reg32s[0] << 2) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[133] = function(a, c) {
    return(a.reg32s[0] << 2) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[134] = function(a) {
    return(a.reg32s[0] << 2) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[135] = function(a) {
    return(a.reg32s[0] << 2) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[192] = function(a) {
    return(a.reg32s[0] << 3) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[193] = function(a) {
    return(a.reg32s[0] << 3) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[194] = function(a) {
    return(a.reg32s[0] << 3) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[195] = function(a) {
    return(a.reg32s[0] << 3) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[196] = function(a) {
    return(a.reg32s[0] << 3) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[197] = function(a, c) {
    return(a.reg32s[0] << 3) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[198] = function(a) {
    return(a.reg32s[0] << 3) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[199] = function(a) {
    return(a.reg32s[0] << 3) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[8] = function(a) {
    return a.reg32s[1] + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[9] = function(a) {
    return a.reg32s[1] + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[10] = function(a) {
    return a.reg32s[1] + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[11] = function(a) {
    return a.reg32s[1] + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[12] = function(a) {
    return a.reg32s[1] + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[13] = function(a, c) {
    return a.reg32s[1] + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[14] = function(a) {
    return a.reg32s[1] + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[15] = function(a) {
    return a.reg32s[1] + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[72] = function(a) {
    return(a.reg32s[1] << 1) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[73] = function(a) {
    return(a.reg32s[1] << 1) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[74] = function(a) {
    return(a.reg32s[1] << 1) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[75] = function(a) {
    return(a.reg32s[1] << 1) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[76] = function(a) {
    return(a.reg32s[1] << 1) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[77] = function(a, c) {
    return(a.reg32s[1] << 1) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[78] = function(a) {
    return(a.reg32s[1] << 1) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[79] = function(a) {
    return(a.reg32s[1] << 1) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[136] = function(a) {
    return(a.reg32s[1] << 2) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[137] = function(a) {
    return(a.reg32s[1] << 2) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[138] = function(a) {
    return(a.reg32s[1] << 2) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[139] = function(a) {
    return(a.reg32s[1] << 2) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[140] = function(a) {
    return(a.reg32s[1] << 2) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[141] = function(a, c) {
    return(a.reg32s[1] << 2) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[142] = function(a) {
    return(a.reg32s[1] << 2) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[143] = function(a) {
    return(a.reg32s[1] << 2) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[200] = function(a) {
    return(a.reg32s[1] << 3) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[201] = function(a) {
    return(a.reg32s[1] << 3) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[202] = function(a) {
    return(a.reg32s[1] << 3) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[203] = function(a) {
    return(a.reg32s[1] << 3) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[204] = function(a) {
    return(a.reg32s[1] << 3) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[205] = function(a, c) {
    return(a.reg32s[1] << 3) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[206] = function(a) {
    return(a.reg32s[1] << 3) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[207] = function(a) {
    return(a.reg32s[1] << 3) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[16] = function(a) {
    return a.reg32s[2] + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[17] = function(a) {
    return a.reg32s[2] + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[18] = function(a) {
    return a.reg32s[2] + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[19] = function(a) {
    return a.reg32s[2] + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[20] = function(a) {
    return a.reg32s[2] + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[21] = function(a, c) {
    return a.reg32s[2] + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[22] = function(a) {
    return a.reg32s[2] + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[23] = function(a) {
    return a.reg32s[2] + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[80] = function(a) {
    return(a.reg32s[2] << 1) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[81] = function(a) {
    return(a.reg32s[2] << 1) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[82] = function(a) {
    return(a.reg32s[2] << 1) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[83] = function(a) {
    return(a.reg32s[2] << 1) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[84] = function(a) {
    return(a.reg32s[2] << 1) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[85] = function(a, c) {
    return(a.reg32s[2] << 1) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[86] = function(a) {
    return(a.reg32s[2] << 1) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[87] = function(a) {
    return(a.reg32s[2] << 1) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[144] = function(a) {
    return(a.reg32s[2] << 2) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[145] = function(a) {
    return(a.reg32s[2] << 2) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[146] = function(a) {
    return(a.reg32s[2] << 2) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[147] = function(a) {
    return(a.reg32s[2] << 2) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[148] = function(a) {
    return(a.reg32s[2] << 2) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[149] = function(a, c) {
    return(a.reg32s[2] << 2) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[150] = function(a) {
    return(a.reg32s[2] << 2) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[151] = function(a) {
    return(a.reg32s[2] << 2) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[208] = function(a) {
    return(a.reg32s[2] << 3) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[209] = function(a) {
    return(a.reg32s[2] << 3) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[210] = function(a) {
    return(a.reg32s[2] << 3) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[211] = function(a) {
    return(a.reg32s[2] << 3) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[212] = function(a) {
    return(a.reg32s[2] << 3) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[213] = function(a, c) {
    return(a.reg32s[2] << 3) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[214] = function(a) {
    return(a.reg32s[2] << 3) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[215] = function(a) {
    return(a.reg32s[2] << 3) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[24] = function(a) {
    return a.reg32s[3] + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[25] = function(a) {
    return a.reg32s[3] + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[26] = function(a) {
    return a.reg32s[3] + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[27] = function(a) {
    return a.reg32s[3] + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[28] = function(a) {
    return a.reg32s[3] + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[29] = function(a, c) {
    return a.reg32s[3] + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[30] = function(a) {
    return a.reg32s[3] + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[31] = function(a) {
    return a.reg32s[3] + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[88] = function(a) {
    return(a.reg32s[3] << 1) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[89] = function(a) {
    return(a.reg32s[3] << 1) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[90] = function(a) {
    return(a.reg32s[3] << 1) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[91] = function(a) {
    return(a.reg32s[3] << 1) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[92] = function(a) {
    return(a.reg32s[3] << 1) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[93] = function(a, c) {
    return(a.reg32s[3] << 1) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[94] = function(a) {
    return(a.reg32s[3] << 1) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[95] = function(a) {
    return(a.reg32s[3] << 1) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[152] = function(a) {
    return(a.reg32s[3] << 2) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[153] = function(a) {
    return(a.reg32s[3] << 2) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[154] = function(a) {
    return(a.reg32s[3] << 2) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[155] = function(a) {
    return(a.reg32s[3] << 2) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[156] = function(a) {
    return(a.reg32s[3] << 2) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[157] = function(a, c) {
    return(a.reg32s[3] << 2) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[158] = function(a) {
    return(a.reg32s[3] << 2) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[159] = function(a) {
    return(a.reg32s[3] << 2) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[216] = function(a) {
    return(a.reg32s[3] << 3) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[217] = function(a) {
    return(a.reg32s[3] << 3) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[218] = function(a) {
    return(a.reg32s[3] << 3) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[219] = function(a) {
    return(a.reg32s[3] << 3) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[220] = function(a) {
    return(a.reg32s[3] << 3) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[221] = function(a, c) {
    return(a.reg32s[3] << 3) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[222] = function(a) {
    return(a.reg32s[3] << 3) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[223] = function(a) {
    return(a.reg32s[3] << 3) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[32] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[33] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[34] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[35] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[36] = function(a) {
    return a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[37] = function(a, c) {
    return(c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[38] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[39] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[96] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[97] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[98] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[99] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[100] = function(a) {
    return a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[101] = function(a, c) {
    return(c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[102] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[103] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[160] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[161] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[162] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[163] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[164] = function(a) {
    return a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[165] = function(a, c) {
    return(c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[166] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[167] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[224] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[225] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[226] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[227] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[228] = function(a) {
    return a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[229] = function(a, c) {
    return(c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[230] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[231] = function(a) {
    return a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[40] = function(a) {
    return a.reg32s[5] + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[41] = function(a) {
    return a.reg32s[5] + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[42] = function(a) {
    return a.reg32s[5] + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[43] = function(a) {
    return a.reg32s[5] + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[44] = function(a) {
    return a.reg32s[5] + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[45] = function(a, c) {
    return a.reg32s[5] + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[46] = function(a) {
    return a.reg32s[5] + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[47] = function(a) {
    return a.reg32s[5] + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[104] = function(a) {
    return(a.reg32s[5] << 1) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[105] = function(a) {
    return(a.reg32s[5] << 1) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[106] = function(a) {
    return(a.reg32s[5] << 1) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[107] = function(a) {
    return(a.reg32s[5] << 1) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[108] = function(a) {
    return(a.reg32s[5] << 1) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[109] = function(a, c) {
    return(a.reg32s[5] << 1) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[110] = function(a) {
    return(a.reg32s[5] << 1) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[111] = function(a) {
    return(a.reg32s[5] << 1) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[168] = function(a) {
    return(a.reg32s[5] << 2) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[169] = function(a) {
    return(a.reg32s[5] << 2) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[170] = function(a) {
    return(a.reg32s[5] << 2) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[171] = function(a) {
    return(a.reg32s[5] << 2) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[172] = function(a) {
    return(a.reg32s[5] << 2) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[173] = function(a, c) {
    return(a.reg32s[5] << 2) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[174] = function(a) {
    return(a.reg32s[5] << 2) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[175] = function(a) {
    return(a.reg32s[5] << 2) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[232] = function(a) {
    return(a.reg32s[5] << 3) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[233] = function(a) {
    return(a.reg32s[5] << 3) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[234] = function(a) {
    return(a.reg32s[5] << 3) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[235] = function(a) {
    return(a.reg32s[5] << 3) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[236] = function(a) {
    return(a.reg32s[5] << 3) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[237] = function(a, c) {
    return(a.reg32s[5] << 3) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[238] = function(a) {
    return(a.reg32s[5] << 3) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[239] = function(a) {
    return(a.reg32s[5] << 3) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[48] = function(a) {
    return a.reg32s[6] + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[49] = function(a) {
    return a.reg32s[6] + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[50] = function(a) {
    return a.reg32s[6] + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[51] = function(a) {
    return a.reg32s[6] + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[52] = function(a) {
    return a.reg32s[6] + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[53] = function(a, c) {
    return a.reg32s[6] + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[54] = function(a) {
    return a.reg32s[6] + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[55] = function(a) {
    return a.reg32s[6] + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[112] = function(a) {
    return(a.reg32s[6] << 1) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[113] = function(a) {
    return(a.reg32s[6] << 1) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[114] = function(a) {
    return(a.reg32s[6] << 1) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[115] = function(a) {
    return(a.reg32s[6] << 1) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[116] = function(a) {
    return(a.reg32s[6] << 1) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[117] = function(a, c) {
    return(a.reg32s[6] << 1) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[118] = function(a) {
    return(a.reg32s[6] << 1) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[119] = function(a) {
    return(a.reg32s[6] << 1) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[176] = function(a) {
    return(a.reg32s[6] << 2) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[177] = function(a) {
    return(a.reg32s[6] << 2) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[178] = function(a) {
    return(a.reg32s[6] << 2) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[179] = function(a) {
    return(a.reg32s[6] << 2) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[180] = function(a) {
    return(a.reg32s[6] << 2) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[181] = function(a, c) {
    return(a.reg32s[6] << 2) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[182] = function(a) {
    return(a.reg32s[6] << 2) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[183] = function(a) {
    return(a.reg32s[6] << 2) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[240] = function(a) {
    return(a.reg32s[6] << 3) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[241] = function(a) {
    return(a.reg32s[6] << 3) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[242] = function(a) {
    return(a.reg32s[6] << 3) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[243] = function(a) {
    return(a.reg32s[6] << 3) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[244] = function(a) {
    return(a.reg32s[6] << 3) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[245] = function(a, c) {
    return(a.reg32s[6] << 3) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[246] = function(a) {
    return(a.reg32s[6] << 3) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[247] = function(a) {
    return(a.reg32s[6] << 3) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[56] = function(a) {
    return a.reg32s[7] + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[57] = function(a) {
    return a.reg32s[7] + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[58] = function(a) {
    return a.reg32s[7] + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[59] = function(a) {
    return a.reg32s[7] + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[60] = function(a) {
    return a.reg32s[7] + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[61] = function(a, c) {
    return a.reg32s[7] + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[62] = function(a) {
    return a.reg32s[7] + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[63] = function(a) {
    return a.reg32s[7] + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[120] = function(a) {
    return(a.reg32s[7] << 1) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[121] = function(a) {
    return(a.reg32s[7] << 1) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[122] = function(a) {
    return(a.reg32s[7] << 1) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[123] = function(a) {
    return(a.reg32s[7] << 1) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[124] = function(a) {
    return(a.reg32s[7] << 1) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[125] = function(a, c) {
    return(a.reg32s[7] << 1) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[126] = function(a) {
    return(a.reg32s[7] << 1) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[127] = function(a) {
    return(a.reg32s[7] << 1) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[184] = function(a) {
    return(a.reg32s[7] << 2) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[185] = function(a) {
    return(a.reg32s[7] << 2) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[186] = function(a) {
    return(a.reg32s[7] << 2) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[187] = function(a) {
    return(a.reg32s[7] << 2) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[188] = function(a) {
    return(a.reg32s[7] << 2) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[189] = function(a, c) {
    return(a.reg32s[7] << 2) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[190] = function(a) {
    return(a.reg32s[7] << 2) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[191] = function(a) {
    return(a.reg32s[7] << 2) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.sib_table[248] = function(a) {
    return(a.reg32s[7] << 3) + a.get_seg_prefix_ds() + a.reg32s[0] | 0;
  };
  CPU.prototype.sib_table[249] = function(a) {
    return(a.reg32s[7] << 3) + a.get_seg_prefix_ds() + a.reg32s[1] | 0;
  };
  CPU.prototype.sib_table[250] = function(a) {
    return(a.reg32s[7] << 3) + a.get_seg_prefix_ds() + a.reg32s[2] | 0;
  };
  CPU.prototype.sib_table[251] = function(a) {
    return(a.reg32s[7] << 3) + a.get_seg_prefix_ds() + a.reg32s[3] | 0;
  };
  CPU.prototype.sib_table[252] = function(a) {
    return(a.reg32s[7] << 3) + a.get_seg_prefix_ss() + a.reg32s[4] | 0;
  };
  CPU.prototype.sib_table[253] = function(a, c) {
    return(a.reg32s[7] << 3) + (c ? a.get_seg_prefix_ss() + a.reg32s[5] : a.get_seg_prefix_ds() + a.read_imm32s()) | 0;
  };
  CPU.prototype.sib_table[254] = function(a) {
    return(a.reg32s[7] << 3) + a.get_seg_prefix_ds() + a.reg32s[6] | 0;
  };
  CPU.prototype.sib_table[255] = function(a) {
    return(a.reg32s[7] << 3) + a.get_seg_prefix_ds() + a.reg32s[7] | 0;
  };
  CPU.prototype.modrm_resolve = function(a) {
    return(this.address_size_32 ? this.modrm_table32 : this.modrm_table16)[a](this);
  };
})();
"use strict";
CPU.prototype.add = function(a, c, d) {
  this.last_op1 = a;
  this.last_op2 = c;
  this.last_add_result = this.last_result = a + c | 0;
  this.last_op_size = d;
  this.flags_changed = 2261;
  return this.last_result;
};
CPU.prototype.adc = function(a, c, d) {
  var e = this.getcf();
  this.last_op1 = a;
  this.last_op2 = c;
  this.last_add_result = this.last_result = (a + c | 0) + e | 0;
  this.last_op_size = d;
  this.flags_changed = 2261;
  return this.last_result;
};
CPU.prototype.sub = function(a, c, d) {
  this.last_add_result = a;
  this.last_op2 = c;
  this.last_op1 = this.last_result = a - c | 0;
  this.last_op_size = d;
  this.flags_changed = 2261;
  return this.last_result;
};
CPU.prototype.sbb = function(a, c, d) {
  var e = this.getcf();
  this.last_add_result = a;
  this.last_op2 = c;
  this.last_op1 = this.last_result = a - c - e | 0;
  this.last_op_size = d;
  this.flags_changed = 2261;
  return this.last_result;
};
CPU.prototype.inc = function(a, c) {
  this.flags = this.flags & -2 | this.getcf();
  this.last_op1 = a;
  this.last_op2 = 1;
  this.last_add_result = this.last_result = a + 1 | 0;
  this.last_op_size = c;
  this.flags_changed = 2260;
  return this.last_result;
};
CPU.prototype.dec = function(a, c) {
  this.flags = this.flags & -2 | this.getcf();
  this.last_add_result = a;
  this.last_op2 = 1;
  this.last_op1 = this.last_result = a - 1 | 0;
  this.last_op_size = c;
  this.flags_changed = 2260;
  return this.last_result;
};
CPU.prototype.neg = function(a, c) {
  this.last_op1 = this.last_result = -a | 0;
  this.flags_changed = 2261;
  this.last_add_result = 0;
  this.last_op2 = a;
  this.last_op_size = c;
  return this.last_result;
};
CPU.prototype.mul8 = function(a) {
  a = a * this.reg8[0];
  this.reg16[0] = a;
  this.flags = 256 > a ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
};
CPU.prototype.imul8 = function(a) {
  a = a * this.reg8s[0];
  this.reg16[0] = a;
  this.flags = 127 < a || -128 > a ? this.flags | 2049 : this.flags & -2050;
  this.flags_changed = 0;
};
CPU.prototype.mul16 = function(a) {
  a = a * this.reg16[0];
  var c = a >>> 16;
  this.reg16[0] = a;
  this.reg16[4] = c;
  this.flags = 0 === c ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
};
CPU.prototype.imul16 = function(a) {
  a = a * this.reg16s[0];
  this.reg16[0] = a;
  this.reg16[4] = a >> 16;
  this.flags = 32767 < a || -32768 > a ? this.flags | 2049 : this.flags & -2050;
  this.flags_changed = 0;
};
CPU.prototype.imul_reg16 = function(a, c) {
  var d = a * c;
  this.flags = 32767 < d || -32768 > d ? this.flags | 2049 : this.flags & -2050;
  this.flags_changed = 0;
  return d;
};
CPU.prototype.mul32 = function(a) {
  var c = this.reg32s[0], d = c & 65535, c = c >>> 16, e = a & 65535;
  a = a >>> 16;
  var f = d * e, e = (f >>> 16) + (c * e | 0) | 0, g = e >>> 16, e = (e & 65535) + (d * a | 0) | 0, g = ((e >>> 16) + (c * a | 0) | 0) + g | 0;
  this.reg32s[0] = e << 16 | f & 65535;
  this.reg32s[2] = g;
  this.flags = 0 === g ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
};
CPU.prototype.imul32 = function(a) {
  var c = this.reg32s[0], d = !1;
  0 > c && (d = !0, c = -c | 0);
  0 > a && (d = !d, a = -a | 0);
  var e = c & 65535, c = c >>> 16, f = a & 65535;
  a = a >>> 16;
  var g = e * f, f = (g >>> 16) + (c * f | 0) | 0, k = f >>> 16, f = (f & 65535) + (e * a | 0) | 0, g = f << 16 | g & 65535, k = ((f >>> 16) + (c * a | 0) | 0) + k | 0;
  d && (g = -g | 0, k = ~k + !g | 0);
  this.reg32s[0] = g;
  this.reg32s[2] = k;
  this.flags = k === g >> 31 ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
};
CPU.prototype.imul_reg32 = function(a, c) {
  var d = !1;
  0 > a && (d = !0, a = -a | 0);
  0 > c && (d = !d, c = -c | 0);
  var e = a & 65535, f = a >>> 16, g = c & 65535, k = c >>> 16, m = e * g, g = (m >>> 16) + (f * g | 0) | 0, l = g >>> 16, g = (g & 65535) + (e * k | 0) | 0, m = g << 16 | m & 65535, l = ((g >>> 16) + (f * k | 0) | 0) + l | 0;
  d && (m = -m | 0, l = ~l + !m | 0);
  this.flags = l === m >> 31 ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
  return m;
};
CPU.prototype.div8 = function(a) {
  var c = this.reg16[0], d = c / a | 0;
  256 <= d || 0 === a ? this.trigger_de() : (this.reg8[0] = d, this.reg8[1] = c % a);
};
CPU.prototype.idiv8 = function(a) {
  var c = this.reg16s[0], d = c / a | 0;
  128 <= d || -129 >= d || 0 === a ? this.trigger_de() : (this.reg8[0] = d, this.reg8[1] = c % a);
};
CPU.prototype.div16 = function(a) {
  var c = (this.reg16[0] | this.reg16[4] << 16) >>> 0, d = c / a | 0;
  65536 <= d || 0 > d || 0 === a ? this.trigger_de() : (this.reg16[0] = d, this.reg16[4] = c % a);
};
CPU.prototype.idiv16 = function(a) {
  var c = this.reg16[0] | this.reg16[4] << 16, d = c / a | 0;
  32768 <= d || -32769 >= d || 0 === a ? this.trigger_de() : (this.reg16[0] = d, this.reg16[4] = c % a);
};
CPU.prototype.div32 = function(a) {
  var c = this.reg32[0], d = this.reg32[2];
  (d >= a || !a) && this.trigger_de();
  var e = 0;
  if (1048576 < d) {
    for (var f = 32, g = a;g > d;) {
      g >>>= 1, f--;
    }
    for (;1048576 < d;) {
      if (d >= g) {
        var d = d - g, k = a << f >>> 0;
        k > c && d--;
        c = c - k >>> 0;
        e |= 1 << f;
      }
      f--;
      g >>= 1;
    }
    e >>>= 0;
  }
  c += 4294967296 * d;
  d = c % a;
  e += c / a | 0;
  4294967296 <= e || 0 === a ? this.trigger_de() : (this.reg32s[0] = e, this.reg32s[2] = d);
};
CPU.prototype.idiv32 = function(a) {
  var c = this.reg32[0], d = this.reg32s[2], e = !1, f = !1;
  0 > a && (f = !0, a = -a);
  0 > d && (e = !0, f = !f, c = -c | 0, d = ~d + !c);
  (d >= a || !a) && this.trigger_de();
  var g = 0;
  if (1048576 < d) {
    for (var k = 32, m = a;m > d;) {
      m >>>= 1, k--;
    }
    for (;1048576 < d;) {
      if (d >= m) {
        var d = d - m, l = a << k >>> 0;
        l > c && d--;
        c = c - l >>> 0;
        g |= 1 << k;
      }
      k--;
      m >>= 1;
    }
    g >>>= 0;
  }
  c += 4294967296 * d;
  d = c % a;
  g += c / a | 0;
  f && (g = -g | 0);
  e && (d = -d | 0);
  2147483648 <= g || -2147483649 >= g || 0 === a ? this.trigger_de() : (this.reg32s[0] = g, this.reg32s[2] = d);
};
CPU.prototype.xadd8 = function(a, c) {
  var d = this.reg8[c];
  this.reg8[c] = a;
  return this.add(a, d, 7);
};
CPU.prototype.xadd16 = function(a, c) {
  var d = this.reg16[c];
  this.reg16[c] = a;
  return this.add(a, d, 15);
};
CPU.prototype.xadd32 = function(a, c) {
  var d = this.reg32s[c];
  this.reg32s[c] = a;
  return this.add(a, d, 31);
};
CPU.prototype.bcd_daa = function() {
  var a = this.reg8[0], c = this.getcf(), d = this.getaf();
  this.flags &= -18;
  if (9 < (a & 15) || d) {
    this.reg8[0] += 6, this.flags |= 16;
  }
  if (153 < a || c) {
    this.reg8[0] += 96, this.flags |= 1;
  }
  this.last_result = this.reg8[0];
  this.last_op_size = 7;
  this.last_op1 = this.last_op2 = 0;
  this.flags_changed = 196;
};
CPU.prototype.bcd_das = function() {
  var a = this.reg8[0], c = this.getcf();
  this.flags &= -2;
  9 < (a & 15) || this.getaf() ? (this.reg8[0] -= 6, this.flags |= 16, this.flags = this.flags & -2 | c | this.reg8[0] >> 7) : this.flags &= -17;
  if (153 < a || c) {
    this.reg8[0] -= 96, this.flags |= 1;
  }
  this.last_result = this.reg8[0];
  this.last_op_size = 7;
  this.last_op1 = this.last_op2 = 0;
  this.flags_changed = 196;
};
CPU.prototype.bcd_aam = function() {
  var a = this.read_imm8();
  if (0 === a) {
    this.trigger_de();
  } else {
    var c = this.reg8[0];
    this.reg8[1] = c / a;
    this.reg8[0] = c % a;
    this.last_result = this.reg8[0];
    this.flags_changed = 196;
    this.flags &= -2066;
  }
};
CPU.prototype.bcd_aad = function() {
  var a = this.read_imm8();
  this.last_result = this.reg8[0] + this.reg8[1] * a;
  this.reg16[0] = this.last_result & 255;
  this.last_op_size = 7;
  this.flags_changed = 196;
  this.flags &= -2066;
};
CPU.prototype.bcd_aaa = function() {
  9 < (this.reg8[0] & 15) || this.getaf() ? (this.reg16[0] += 6, this.reg8[1] += 1, this.flags |= 17) : this.flags &= -18;
  this.reg8[0] &= 15;
  this.flags_changed &= -18;
};
CPU.prototype.bcd_aas = function() {
  9 < (this.reg8[0] & 15) || this.getaf() ? (this.reg16[0] -= 6, --this.reg8[1], this.flags |= 17) : this.flags &= -18;
  this.reg8[0] &= 15;
  this.flags_changed &= -18;
};
CPU.prototype.and = function(a, c, d) {
  this.last_result = a & c;
  this.last_op_size = d;
  this.flags &= -2066;
  this.flags_changed = 196;
  return this.last_result;
};
CPU.prototype.or = function(a, c, d) {
  this.last_result = a | c;
  this.last_op_size = d;
  this.flags &= -2066;
  this.flags_changed = 196;
  return this.last_result;
};
CPU.prototype.xor = function(a, c, d) {
  this.last_result = a ^ c;
  this.last_op_size = d;
  this.flags &= -2066;
  this.flags_changed = 196;
  return this.last_result;
};
CPU.prototype.rol8 = function(a, c) {
  if (!c) {
    return a;
  }
  c &= 7;
  var d = a << c | a >> 8 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d & 1 | (d << 11 ^ d << 4) & 2048;
  return d;
};
CPU.prototype.rol16 = function(a, c) {
  if (!c) {
    return a;
  }
  c &= 15;
  var d = a << c | a >> 16 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d & 1 | (d << 11 ^ d >> 4) & 2048;
  return d;
};
CPU.prototype.rol32 = function(a, c) {
  if (!c) {
    return a;
  }
  var d = a << c | a >>> 32 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d & 1 | (d << 11 ^ d >> 20) & 2048;
  return d;
};
CPU.prototype.rcl8 = function(a, c) {
  c %= 9;
  if (!c) {
    return a;
  }
  var d = a << c | this.getcf() << c - 1 | a >> 9 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d >> 8 & 1 | (d << 3 ^ d << 4) & 2048;
  return d;
};
CPU.prototype.rcl16 = function(a, c) {
  c %= 17;
  if (!c) {
    return a;
  }
  var d = a << c | this.getcf() << c - 1 | a >> 17 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d >> 16 & 1 | (d >> 5 ^ d >> 4) & 2048;
  return d;
};
CPU.prototype.rcl32 = function(a, c) {
  if (!c) {
    return a;
  }
  var d = a << c | this.getcf() << c - 1;
  1 < c && (d |= a >>> 33 - c);
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | a >>> 32 - c & 1;
  this.flags |= (this.flags << 11 ^ d >> 20) & 2048;
  return d;
};
CPU.prototype.ror8 = function(a, c) {
  c &= 7;
  if (!c) {
    return a;
  }
  var d = a >> c | a << 8 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d >> 7 & 1 | (d << 4 ^ d << 5) & 2048;
  return d;
};
CPU.prototype.ror16 = function(a, c) {
  c &= 15;
  if (!c) {
    return a;
  }
  var d = a >> c | a << 16 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d >> 15 & 1 | (d >> 4 ^ d >> 3) & 2048;
  return d;
};
CPU.prototype.ror32 = function(a, c) {
  if (!c) {
    return a;
  }
  var d = a >>> c | a << 32 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d >> 31 & 1 | (d >> 20 ^ d >> 19) & 2048;
  return d;
};
CPU.prototype.rcr8 = function(a, c) {
  c %= 9;
  if (!c) {
    return a;
  }
  var d = a >> c | this.getcf() << 8 - c | a << 9 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d >> 8 & 1 | (d << 4 ^ d << 5) & 2048;
  return d;
};
CPU.prototype.rcr16 = function(a, c) {
  c %= 17;
  if (!c) {
    return a;
  }
  var d = a >> c | this.getcf() << 16 - c | a << 17 - c;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | d >> 16 & 1 | (d >> 4 ^ d >> 3) & 2048;
  return d;
};
CPU.prototype.rcr32 = function(a, c) {
  if (!c) {
    return a;
  }
  var d = a >>> c | this.getcf() << 32 - c;
  1 < c && (d |= a << 33 - c);
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | a >> c - 1 & 1 | (d >> 20 ^ d >> 19) & 2048;
  return d;
};
CPU.prototype.shl8 = function(a, c) {
  if (0 === c) {
    return a;
  }
  this.last_result = a << c;
  this.last_op_size = 7;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | this.last_result >> 8 & 1 | (this.last_result << 3 ^ this.last_result << 4) & 2048;
  return this.last_result;
};
CPU.prototype.shl16 = function(a, c) {
  if (0 === c) {
    return a;
  }
  this.last_result = a << c;
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | this.last_result >> 16 & 1 | (this.last_result >> 5 ^ this.last_result >> 4) & 2048;
  return this.last_result;
};
CPU.prototype.shl32 = function(a, c) {
  if (0 === c) {
    return a;
  }
  this.last_result = a << c;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | a >>> 32 - c & 1;
  this.flags |= (this.flags & 1 ^ this.last_result >> 31 & 1) << 11 & 2048;
  return this.last_result;
};
CPU.prototype.shr8 = function(a, c) {
  if (0 === c) {
    return a;
  }
  this.last_result = a >> c;
  this.last_op_size = 7;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | a >> c - 1 & 1 | (a >> 7 & 1) << 11 & 2048;
  return this.last_result;
};
CPU.prototype.shr16 = function(a, c) {
  if (0 === c) {
    return a;
  }
  this.last_result = a >> c;
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | a >> c - 1 & 1 | a >> 4 & 2048;
  return this.last_result;
};
CPU.prototype.shr32 = function(a, c) {
  if (0 === c) {
    return a;
  }
  this.last_result = a >>> c;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | a >>> c - 1 & 1 | a >> 20 & 2048;
  return this.last_result;
};
CPU.prototype.sar8 = function(a, c) {
  if (0 === c) {
    return a;
  }
  this.last_result = a >> c;
  this.last_op_size = 7;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | a >> c - 1 & 1;
  return this.last_result;
};
CPU.prototype.sar16 = function(a, c) {
  if (0 === c) {
    return a;
  }
  this.last_result = a >> c;
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | a >> c - 1 & 1;
  return this.last_result;
};
CPU.prototype.sar32 = function(a, c) {
  if (0 === c) {
    return a;
  }
  this.last_result = a >> c;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | a >>> c - 1 & 1;
  return this.last_result;
};
CPU.prototype.shrd16 = function(a, c, d) {
  if (0 === d) {
    return a;
  }
  16 >= d ? (this.last_result = a >> d | c << 16 - d, this.flags = this.flags & -2 | a >> d - 1 & 1) : (this.last_result = a << 32 - d | c >> d - 16, this.flags = this.flags & -2 | c >> d - 17 & 1);
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2049 | (this.last_result ^ a) >> 4 & 2048;
  return this.last_result;
};
CPU.prototype.shrd32 = function(a, c, d) {
  if (0 === d) {
    return a;
  }
  this.last_result = a >>> d | c << 32 - d;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2 | a >>> d - 1 & 1;
  this.flags = this.flags & -2049 | (this.last_result ^ a) >> 20 & 2048;
  return this.last_result;
};
CPU.prototype.shld16 = function(a, c, d) {
  if (0 === d) {
    return a;
  }
  16 >= d ? (this.last_result = a << d | c >>> 16 - d, this.flags = this.flags & -2 | a >>> 16 - d & 1) : (this.last_result = a >> 32 - d | c << d - 16, this.flags = this.flags & -2 | c >>> 32 - d & 1);
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2049 | (this.flags & 1 ^ this.last_result >> 15 & 1) << 11;
  return this.last_result;
};
CPU.prototype.shld32 = function(a, c, d) {
  if (0 === d) {
    return a;
  }
  this.last_result = a << d | c >>> 32 - d;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2 | a >>> 32 - d & 1;
  this.flags = this.flags & -2049 | (this.flags & 1 ^ this.last_result >> 31 & 1) << 11;
  return this.last_result;
};
CPU.prototype.bt_reg = function(a, c) {
  this.flags = this.flags & -2 | a >> c & 1;
  this.flags_changed &= -2;
};
CPU.prototype.btc_reg = function(a, c) {
  this.flags = this.flags & -2 | a >> c & 1;
  this.flags_changed &= -2;
  return a ^ 1 << c;
};
CPU.prototype.bts_reg = function(a, c) {
  this.flags = this.flags & -2 | a >> c & 1;
  this.flags_changed &= -2;
  return a | 1 << c;
};
CPU.prototype.btr_reg = function(a, c) {
  this.flags = this.flags & -2 | a >> c & 1;
  this.flags_changed &= -2;
  return a & ~(1 << c);
};
CPU.prototype.bt_mem = function(a, c) {
  var d = this.safe_read8(a + (c >> 3));
  this.flags = this.flags & -2 | d >> (c & 7) & 1;
  this.flags_changed &= -2;
};
CPU.prototype.btc_mem = function(a, c) {
  var d = this.translate_address_write(a + (c >> 3)), e = this.memory.read8(d);
  c &= 7;
  this.flags = this.flags & -2 | e >> c & 1;
  this.flags_changed &= -2;
  this.memory.write8(d, e ^ 1 << c);
};
CPU.prototype.btr_mem = function(a, c) {
  var d = this.translate_address_write(a + (c >> 3)), e = this.memory.read8(d);
  c &= 7;
  this.flags = this.flags & -2 | e >> c & 1;
  this.flags_changed &= -2;
  this.memory.write8(d, e & ~(1 << c));
};
CPU.prototype.bts_mem = function(a, c) {
  var d = this.translate_address_write(a + (c >> 3)), e = this.memory.read8(d);
  c &= 7;
  this.flags = this.flags & -2 | e >> c & 1;
  this.flags_changed &= -2;
  this.memory.write8(d, e | 1 << c);
};
CPU.prototype.bsf16 = function(a, c) {
  this.flags_changed = 0;
  if (0 === c) {
    return this.flags |= 64, a;
  }
  this.flags &= -65;
  return Math.int_log2(-c & c);
};
CPU.prototype.bsf32 = function(a, c) {
  this.flags_changed = 0;
  if (0 === c) {
    return this.flags |= 64, a;
  }
  this.flags &= -65;
  return Math.int_log2((-c & c) >>> 0);
};
CPU.prototype.bsr16 = function(a, c) {
  this.flags_changed = 0;
  if (0 === c) {
    return this.flags |= 64, a;
  }
  this.flags &= -65;
  return Math.int_log2(c);
};
CPU.prototype.bsr32 = function(a, c) {
  this.flags_changed = 0;
  if (0 === c) {
    return this.flags |= 64, a;
  }
  this.flags &= -65;
  return Math.int_log2(c >>> 0);
};
CPU.prototype.popcnt = function(a) {
  this.flags_changed = 0;
  this.flags &= -2262;
  if (a) {
    return a = a - (a >> 1 & 1431655765), a = (a & 858993459) + (a >> 2 & 858993459), 16843009 * (a + (a >> 4) & 252645135) >> 24;
  }
  this.flags |= 64;
  return 0;
};
"use strict";
var data_dest, data_src;
CPU.prototype.string_instruction = function(a, c, d, e, f, g) {
  var k, m, l, n, p = this.flags & 1024 ? -(a >> 3) : a >> 3, q = !1;
  c && !d && (data_src = 32 === a ? this.reg32s[0] : 16 === a ? this.reg16[0] : this.reg8[0]);
  e && (m = this.get_seg(0) + this.regv[this.reg_vdi] | 0);
  d && (k = this.get_seg_prefix(3) + this.regv[this.reg_vsi] | 0);
  if (0 !== this.repeat_string_prefix) {
    var r = this.regv[this.reg_vcx] >>> 0, s = r;
    if (0 === r) {
      return;
    }
    var t = 16384;
    if (8 !== a && (e && m & (a >> 3) - 1 || d && k & (a >> 3) - 1)) {
      do {
        f(this, k, m), e && (m += p, this.regv[this.reg_vdi] += p), d && (k += p, this.regv[this.reg_vsi] += p), q = 0 !== --this.regv[this.reg_vcx] && (!c || data_src === data_dest === (2 === this.repeat_string_prefix));
      } while (q && t--);
    } else {
      f = p >> 31 | 1;
      this.paging ? (d && (t = (f >> 1 ^ ~k) & 4095, n = this.translate_address_read(k)), e && (t = Math.min(t, (f >> 1 ^ ~m) & 4095), l = c ? this.translate_address_read(m) : this.translate_address_write(m)), 32 === a ? t >>= 2 : 16 === a && (t >>= 1)) : (e && (l = m), d && (n = k));
      32 === a ? (e && (l >>>= 2), d && (n >>>= 2)) : 16 === a && (e && (l >>>= 1), d && (n >>>= 1));
      do {
        g(this, n, l), e && (l += f), d && (n += f), q = 0 !== --r && (!c || data_src === data_dest === (2 === this.repeat_string_prefix));
      } while (q && t--);
      g = p * (s - r) | 0;
      e && (this.regv[this.reg_vdi] += g);
      d && (this.regv[this.reg_vsi] += g);
      this.regv[this.reg_vcx] = r;
      this.timestamp_counter += s - r;
    }
  } else {
    8 === a ? (d && (n = this.translate_address_read(k)), e && (l = c ? this.translate_address_read(m) : this.translate_address_write(m)), g(this, n, l)) : f(this, k, m), e && (this.regv[this.reg_vdi] += p), d && (this.regv[this.reg_vsi] += p);
  }
  c && (32 === a ? this.sub(data_src, data_dest, 31) : 16 === a ? this.sub(data_src, data_dest, 15) : this.sub(data_src, data_dest, 7));
  q && (this.instruction_pointer = this.previous_ip);
};
function movsb(a) {
  a.string_instruction(8, !1, !0, !0, function() {
  }, function(a, d, e) {
    a.memory.write8(e, a.memory.read8(d));
  });
}
function movsw(a) {
  a.string_instruction(16, !1, !0, !0, function(a, d, e) {
    a.safe_write16(e, a.safe_read16(d));
  }, function(a, d, e) {
    a.memory.write_aligned16(e, a.memory.read_aligned16(d));
  });
}
function movsd(a) {
  if (0 !== a.repeat_string_prefix) {
    var c = a.get_seg_prefix(3) + a.regv[a.reg_vsi], d = a.get_seg(0) + a.regv[a.reg_vdi], e = a.regv[a.reg_vcx] >>> 0;
    if (!e) {
      return;
    }
    var f = a.paging ? 4095 : 3;
    if (0 === (d & f) && 0 === (c & f) && 0 === (a.flags & 1024) && (f = !1, a.paging && (c = a.translate_address_read(c), d = a.translate_address_write(d), 1024 < e && (e = 1024, f = !0)), !a.io.in_mmap_range(c, e) && !a.io.in_mmap_range(d, e))) {
      var g = e << 2;
      a.regv[a.reg_vcx] -= e;
      a.regv[a.reg_vdi] += g;
      a.regv[a.reg_vsi] += g;
      c >>= 2;
      a.memory.mem32s.set(a.memory.mem32s.subarray(c, c + e), d >> 2);
      f && (a.instruction_pointer = a.previous_ip);
      return;
    }
  }
  a.string_instruction(32, !1, !0, !0, function(a, c, d) {
    a.safe_write32(d, a.safe_read32s(c));
  }, function(a, c, d) {
    a.memory.write_aligned32(d, a.memory.read_aligned32(c));
  });
}
function cmpsb(a) {
  a.string_instruction(8, !0, !0, !0, function() {
  }, function(a, d, e) {
    data_dest = a.memory.read8(e);
    data_src = a.memory.read8(d);
  });
}
function cmpsw(a) {
  a.string_instruction(16, !0, !0, !0, function(a, d, e) {
    data_dest = a.safe_read16(e);
    data_src = a.safe_read16(d);
  }, function(a, d, e) {
    data_dest = a.memory.read_aligned16(e);
    data_src = a.memory.read_aligned16(d);
  });
}
function cmpsd(a) {
  a.string_instruction(32, !0, !0, !0, function(a, d, e) {
    data_dest = a.safe_read32s(e);
    data_src = a.safe_read32s(d);
  }, function(a, d, e) {
    data_dest = a.memory.read_aligned32(e);
    data_src = a.memory.read_aligned32(d);
  });
}
function stosb(a) {
  var c = a.reg8[0];
  a.string_instruction(8, !1, !1, !0, function() {
  }, function(a, e, f) {
    a.memory.write8(f, c);
  });
}
function stosw(a) {
  var c = a.reg16[0];
  a.string_instruction(16, !1, !1, !0, function(a, e, f) {
    a.safe_write16(f, c);
  }, function(a, e, f) {
    a.memory.write_aligned16(f, c);
  });
}
function stosd(a) {
  var c = a.reg32s[0];
  a.string_instruction(32, !1, !1, !0, function(a, e, f) {
    a.safe_write32(f, c);
  }, function(a, e, f) {
    a.memory.write_aligned32(f, c);
  });
}
function lodsb(a) {
  a.string_instruction(8, !1, !0, !1, function() {
  }, function(a, d) {
    a.reg8[0] = a.memory.read8(d);
  });
}
function lodsw(a) {
  a.string_instruction(16, !1, !0, !1, function(a, d) {
    a.reg16[0] = a.safe_read16(d);
  }, function(a, d) {
    a.reg16[0] = a.memory.read_aligned16(d);
  });
}
function lodsd(a) {
  a.string_instruction(32, !1, !0, !1, function(a, d) {
    a.reg32s[0] = a.safe_read32s(d);
  }, function(a, d) {
    a.reg32s[0] = a.memory.read_aligned32(d);
  });
}
function scasb(a) {
  a.string_instruction(8, !0, !1, !0, function() {
  }, function(a, d, e) {
    data_dest = a.memory.read8(e);
  });
}
function scasw(a) {
  a.string_instruction(16, !0, !1, !0, function(a, d, e) {
    data_dest = a.safe_read16(e);
  }, function(a, d, e) {
    data_dest = a.memory.read_aligned16(e);
  });
}
function scasd(a) {
  a.string_instruction(32, !0, !1, !0, function(a, d, e) {
    data_dest = a.safe_read32s(e);
  }, function(a, d, e) {
    data_dest = a.memory.read_aligned32(e);
  });
}
function insb(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 1);
  a.string_instruction(8, !1, !1, !0, function() {
  }, function(a, e, f) {
    a.memory.write8(f, a.io.port_read8(c));
  });
}
function insw(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 2);
  a.string_instruction(16, !1, !1, !0, function(a, e, f) {
    a.safe_write16(f, a.io.port_read16(c));
  }, function(a, e, f) {
    a.memory.write_aligned16(f, a.io.port_read16(c));
  });
}
function insd(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 4);
  a.string_instruction(32, !1, !1, !0, function(a, e, f) {
    a.safe_write32(f, a.io.port_read32(c));
  }, function(a, e, f) {
    a.memory.write_aligned32(f, a.io.port_read32(c));
  });
}
function outsb(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 1);
  a.string_instruction(8, !1, !0, !1, function() {
  }, function(a, e) {
    a.io.port_write8(c, a.memory.read8(e));
  });
}
function outsw(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 2);
  a.string_instruction(16, !1, !0, !1, function(a, e) {
    a.io.port_write16(c, a.safe_read16(e));
  }, function(a, e) {
    a.io.port_write16(c, a.memory.read_aligned16(e));
  });
}
function outsd(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 4);
  a.string_instruction(32, !1, !0, !1, function(a, e) {
    a.io.port_write32(c, a.safe_read32s(e));
  }, function(a, e) {
    a.io.port_write32(c, a.memory.read_aligned32(e));
  });
}
"use strict";
var table16 = [], table32 = [], table0F_16 = [], table0F_32 = [];
CPU.prototype.table16 = table16;
CPU.prototype.table32 = table32;
CPU.prototype.table0F_16 = table0F_16;
CPU.prototype.table0F_32 = table0F_32;
table16[0] = table32[0] = function(a) {
  var c = a.read_imm8(), d, e;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  d = a.add(d, a.reg8[c >> 1 & 12 | c >> 5 & 1], 7);
  192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
};
table16[1] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.add(d, a.reg16[c >> 2 & 14], 15);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table32[1] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.add(d, a.reg32s[c >> 3 & 7], 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table16[2] = table32[2] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg8[c >> 1 & 12 | c >> 5 & 1] = a.add(a.reg8[c >> 1 & 12 | c >> 5 & 1], d, 7);
};
table16[3] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.add(a.reg16[c >> 2 & 14], d, 15);
};
table32[3] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.add(a.reg32s[c >> 3 & 7], d, 31);
};
table16[4] = table32[4] = function(a) {
  a.reg8[0] = a.add(a.reg8[0], a.read_imm8(), 7);
};
table16[5] = function(a) {
  a.reg16[0] = a.add(a.reg16[0], a.read_imm16(), 15);
};
table32[5] = function(a) {
  a.reg32s[0] = a.add(a.reg32s[0], a.read_imm32s(), 31);
};
table16[6] = function(a) {
  a.push16(a.sreg[0]);
};
table32[6] = function(a) {
  a.push32(a.sreg[0]);
};
table16[7] = function(a) {
  a.switch_seg(0, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 2;
};
table32[7] = function(a) {
  a.switch_seg(0, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 4;
};
table16[8] = table32[8] = function(a) {
  var c = a.read_imm8(), d, e;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  d = a.or(d, a.reg8[c >> 1 & 12 | c >> 5 & 1], 7);
  192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
};
table16[9] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.or(d, a.reg16[c >> 2 & 14], 15);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table32[9] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.or(d, a.reg32s[c >> 3 & 7], 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table16[10] = table32[10] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg8[c >> 1 & 12 | c >> 5 & 1] = a.or(a.reg8[c >> 1 & 12 | c >> 5 & 1], d, 7);
};
table16[11] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.or(a.reg16[c >> 2 & 14], d, 15);
};
table32[11] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.or(a.reg32s[c >> 3 & 7], d, 31);
};
table16[12] = table32[12] = function(a) {
  a.reg8[0] = a.or(a.reg8[0], a.read_imm8(), 7);
};
table16[13] = function(a) {
  a.reg16[0] = a.or(a.reg16[0], a.read_imm16(), 15);
};
table32[13] = function(a) {
  a.reg32s[0] = a.or(a.reg32s[0], a.read_imm32s(), 31);
};
table16[14] = function(a) {
  a.push16(a.sreg[1]);
};
table32[14] = function(a) {
  a.push32(a.sreg[1]);
};
table16[15] = table32[15] = function(a) {
  a.table0F[a.read_imm8()](a);
};
table16[16] = table32[16] = function(a) {
  var c = a.read_imm8(), d, e;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  d = a.adc(d, a.reg8[c >> 1 & 12 | c >> 5 & 1], 7);
  192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
};
table16[17] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.adc(d, a.reg16[c >> 2 & 14], 15);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table32[17] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.adc(d, a.reg32s[c >> 3 & 7], 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table16[18] = table32[18] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg8[c >> 1 & 12 | c >> 5 & 1] = a.adc(a.reg8[c >> 1 & 12 | c >> 5 & 1], d, 7);
};
table16[19] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.adc(a.reg16[c >> 2 & 14], d, 15);
};
table32[19] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.adc(a.reg32s[c >> 3 & 7], d, 31);
};
table16[20] = table32[20] = function(a) {
  a.reg8[0] = a.adc(a.reg8[0], a.read_imm8(), 7);
};
table16[21] = function(a) {
  a.reg16[0] = a.adc(a.reg16[0], a.read_imm16(), 15);
};
table32[21] = function(a) {
  a.reg32s[0] = a.adc(a.reg32s[0], a.read_imm32s(), 31);
};
table16[22] = function(a) {
  a.push16(a.sreg[2]);
};
table32[22] = function(a) {
  a.push32(a.sreg[2]);
};
table16[23] = function(a) {
  a.switch_seg(2, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 2;
};
table32[23] = function(a) {
  a.switch_seg(2, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 4;
};
table16[24] = table32[24] = function(a) {
  var c = a.read_imm8(), d, e;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  d = a.sbb(d, a.reg8[c >> 1 & 12 | c >> 5 & 1], 7);
  192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
};
table16[25] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.sbb(d, a.reg16[c >> 2 & 14], 15);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table32[25] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.sbb(d, a.reg32s[c >> 3 & 7], 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table16[26] = table32[26] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg8[c >> 1 & 12 | c >> 5 & 1] = a.sbb(a.reg8[c >> 1 & 12 | c >> 5 & 1], d, 7);
};
table16[27] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.sbb(a.reg16[c >> 2 & 14], d, 15);
};
table32[27] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.sbb(a.reg32s[c >> 3 & 7], d, 31);
};
table16[28] = table32[28] = function(a) {
  a.reg8[0] = a.sbb(a.reg8[0], a.read_imm8(), 7);
};
table16[29] = function(a) {
  a.reg16[0] = a.sbb(a.reg16[0], a.read_imm16(), 15);
};
table32[29] = function(a) {
  a.reg32s[0] = a.sbb(a.reg32s[0], a.read_imm32s(), 31);
};
table16[30] = function(a) {
  a.push16(a.sreg[3]);
};
table32[30] = function(a) {
  a.push32(a.sreg[3]);
};
table16[31] = function(a) {
  a.switch_seg(3, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 2;
};
table32[31] = function(a) {
  a.switch_seg(3, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 4;
};
table16[32] = table32[32] = function(a) {
  var c = a.read_imm8(), d, e;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  d = a.and(d, a.reg8[c >> 1 & 12 | c >> 5 & 1], 7);
  192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
};
table16[33] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.and(d, a.reg16[c >> 2 & 14], 15);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table32[33] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.and(d, a.reg32s[c >> 3 & 7], 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table16[34] = table32[34] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg8[c >> 1 & 12 | c >> 5 & 1] = a.and(a.reg8[c >> 1 & 12 | c >> 5 & 1], d, 7);
};
table16[35] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.and(a.reg16[c >> 2 & 14], d, 15);
};
table32[35] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.and(a.reg32s[c >> 3 & 7], d, 31);
};
table16[36] = table32[36] = function(a) {
  a.reg8[0] = a.and(a.reg8[0], a.read_imm8(), 7);
};
table16[37] = function(a) {
  a.reg16[0] = a.and(a.reg16[0], a.read_imm16(), 15);
};
table32[37] = function(a) {
  a.reg32s[0] = a.and(a.reg32s[0], a.read_imm32s(), 31);
};
table16[38] = table32[38] = function(a) {
  a.seg_prefix(0);
};
table16[39] = table32[39] = function(a) {
  a.bcd_daa();
};
table16[40] = table32[40] = function(a) {
  var c = a.read_imm8(), d, e;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  d = a.sub(d, a.reg8[c >> 1 & 12 | c >> 5 & 1], 7);
  192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
};
table16[41] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.sub(d, a.reg16[c >> 2 & 14], 15);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table32[41] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.sub(d, a.reg32s[c >> 3 & 7], 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table16[42] = table32[42] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg8[c >> 1 & 12 | c >> 5 & 1] = a.sub(a.reg8[c >> 1 & 12 | c >> 5 & 1], d, 7);
};
table16[43] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.sub(a.reg16[c >> 2 & 14], d, 15);
};
table32[43] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.sub(a.reg32s[c >> 3 & 7], d, 31);
};
table16[44] = table32[44] = function(a) {
  a.reg8[0] = a.sub(a.reg8[0], a.read_imm8(), 7);
};
table16[45] = function(a) {
  a.reg16[0] = a.sub(a.reg16[0], a.read_imm16(), 15);
};
table32[45] = function(a) {
  a.reg32s[0] = a.sub(a.reg32s[0], a.read_imm32s(), 31);
};
table16[46] = table32[46] = function(a) {
  a.seg_prefix(1);
};
table16[47] = table32[47] = function(a) {
  a.bcd_das();
};
table16[48] = table32[48] = function(a) {
  var c = a.read_imm8(), d, e;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  d = a.xor(d, a.reg8[c >> 1 & 12 | c >> 5 & 1], 7);
  192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
};
table16[49] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.xor(d, a.reg16[c >> 2 & 14], 15);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table32[49] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.xor(d, a.reg32s[c >> 3 & 7], 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table16[50] = table32[50] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg8[c >> 1 & 12 | c >> 5 & 1] = a.xor(a.reg8[c >> 1 & 12 | c >> 5 & 1], d, 7);
};
table16[51] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.xor(a.reg16[c >> 2 & 14], d, 15);
};
table32[51] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.xor(a.reg32s[c >> 3 & 7], d, 31);
};
table16[52] = table32[52] = function(a) {
  a.reg8[0] = a.xor(a.reg8[0], a.read_imm8(), 7);
};
table16[53] = function(a) {
  a.reg16[0] = a.xor(a.reg16[0], a.read_imm16(), 15);
};
table32[53] = function(a) {
  a.reg32s[0] = a.xor(a.reg32s[0], a.read_imm32s(), 31);
};
table16[54] = table32[54] = function(a) {
  a.seg_prefix(2);
};
table16[55] = table32[55] = function(a) {
  a.bcd_aaa();
};
table16[56] = table32[56] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.sub(d, a.reg8[c >> 1 & 12 | c >> 5 & 1], 7);
};
table16[57] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.sub(d, a.reg16[c >> 2 & 14], 15);
};
table32[57] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.sub(d, a.reg32s[c >> 3 & 7], 31);
};
table16[58] = table32[58] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.sub(a.reg8[c >> 1 & 12 | c >> 5 & 1], d, 7);
};
table16[59] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.sub(a.reg16[c >> 2 & 14], d, 15);
};
table32[59] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.sub(a.reg32s[c >> 3 & 7], d, 31);
};
table16[60] = table32[60] = function(a) {
  a.sub(a.reg8[0], a.read_imm8(), 7);
};
table16[61] = function(a) {
  a.sub(a.reg16[0], a.read_imm16(), 15);
};
table32[61] = function(a) {
  a.sub(a.reg32s[0], a.read_imm32s(), 31);
};
table16[62] = table32[62] = function(a) {
  a.seg_prefix(3);
};
table16[63] = table32[63] = function(a) {
  a.bcd_aas();
};
table16[64] = function(a) {
  a.reg16[0] = a.inc(a.reg16[0], 15);
};
table32[64] = function(a) {
  a.reg32s[0] = a.inc(a.reg32s[0], 31);
};
table16[65] = function(a) {
  a.reg16[2] = a.inc(a.reg16[2], 15);
};
table32[65] = function(a) {
  a.reg32s[1] = a.inc(a.reg32s[1], 31);
};
table16[66] = function(a) {
  a.reg16[4] = a.inc(a.reg16[4], 15);
};
table32[66] = function(a) {
  a.reg32s[2] = a.inc(a.reg32s[2], 31);
};
table16[67] = function(a) {
  a.reg16[6] = a.inc(a.reg16[6], 15);
};
table32[67] = function(a) {
  a.reg32s[3] = a.inc(a.reg32s[3], 31);
};
table16[68] = function(a) {
  a.reg16[8] = a.inc(a.reg16[8], 15);
};
table32[68] = function(a) {
  a.reg32s[4] = a.inc(a.reg32s[4], 31);
};
table16[69] = function(a) {
  a.reg16[10] = a.inc(a.reg16[10], 15);
};
table32[69] = function(a) {
  a.reg32s[5] = a.inc(a.reg32s[5], 31);
};
table16[70] = function(a) {
  a.reg16[12] = a.inc(a.reg16[12], 15);
};
table32[70] = function(a) {
  a.reg32s[6] = a.inc(a.reg32s[6], 31);
};
table16[71] = function(a) {
  a.reg16[14] = a.inc(a.reg16[14], 15);
};
table32[71] = function(a) {
  a.reg32s[7] = a.inc(a.reg32s[7], 31);
};
table16[72] = function(a) {
  a.reg16[0] = a.dec(a.reg16[0], 15);
};
table32[72] = function(a) {
  a.reg32s[0] = a.dec(a.reg32s[0], 31);
};
table16[73] = function(a) {
  a.reg16[2] = a.dec(a.reg16[2], 15);
};
table32[73] = function(a) {
  a.reg32s[1] = a.dec(a.reg32s[1], 31);
};
table16[74] = function(a) {
  a.reg16[4] = a.dec(a.reg16[4], 15);
};
table32[74] = function(a) {
  a.reg32s[2] = a.dec(a.reg32s[2], 31);
};
table16[75] = function(a) {
  a.reg16[6] = a.dec(a.reg16[6], 15);
};
table32[75] = function(a) {
  a.reg32s[3] = a.dec(a.reg32s[3], 31);
};
table16[76] = function(a) {
  a.reg16[8] = a.dec(a.reg16[8], 15);
};
table32[76] = function(a) {
  a.reg32s[4] = a.dec(a.reg32s[4], 31);
};
table16[77] = function(a) {
  a.reg16[10] = a.dec(a.reg16[10], 15);
};
table32[77] = function(a) {
  a.reg32s[5] = a.dec(a.reg32s[5], 31);
};
table16[78] = function(a) {
  a.reg16[12] = a.dec(a.reg16[12], 15);
};
table32[78] = function(a) {
  a.reg32s[6] = a.dec(a.reg32s[6], 31);
};
table16[79] = function(a) {
  a.reg16[14] = a.dec(a.reg16[14], 15);
};
table32[79] = function(a) {
  a.reg32s[7] = a.dec(a.reg32s[7], 31);
};
table16[80] = function(a) {
  a.push16(a.reg16[0]);
};
table32[80] = function(a) {
  a.push32(a.reg32s[0]);
};
table16[81] = function(a) {
  a.push16(a.reg16[2]);
};
table32[81] = function(a) {
  a.push32(a.reg32s[1]);
};
table16[82] = function(a) {
  a.push16(a.reg16[4]);
};
table32[82] = function(a) {
  a.push32(a.reg32s[2]);
};
table16[83] = function(a) {
  a.push16(a.reg16[6]);
};
table32[83] = function(a) {
  a.push32(a.reg32s[3]);
};
table16[84] = function(a) {
  a.push16(a.reg16[8]);
};
table32[84] = function(a) {
  a.push32(a.reg32s[4]);
};
table16[85] = function(a) {
  a.push16(a.reg16[10]);
};
table32[85] = function(a) {
  a.push32(a.reg32s[5]);
};
table16[86] = function(a) {
  a.push16(a.reg16[12]);
};
table32[86] = function(a) {
  a.push32(a.reg32s[6]);
};
table16[87] = function(a) {
  a.push16(a.reg16[14]);
};
table32[87] = function(a) {
  a.push32(a.reg32s[7]);
};
table16[88] = function(a) {
  a.reg16[0] = a.pop16();
};
table32[88] = function(a) {
  a.reg32s[0] = a.pop32s();
};
table16[89] = function(a) {
  a.reg16[2] = a.pop16();
};
table32[89] = function(a) {
  a.reg32s[1] = a.pop32s();
};
table16[90] = function(a) {
  a.reg16[4] = a.pop16();
};
table32[90] = function(a) {
  a.reg32s[2] = a.pop32s();
};
table16[91] = function(a) {
  a.reg16[6] = a.pop16();
};
table32[91] = function(a) {
  a.reg32s[3] = a.pop32s();
};
table16[92] = function(a) {
  a.reg16[8] = a.pop16();
};
table32[92] = function(a) {
  a.reg32s[4] = a.pop32s();
};
table16[93] = function(a) {
  a.reg16[10] = a.pop16();
};
table32[93] = function(a) {
  a.reg32s[5] = a.pop32s();
};
table16[94] = function(a) {
  a.reg16[12] = a.pop16();
};
table32[94] = function(a) {
  a.reg32s[6] = a.pop32s();
};
table16[95] = function(a) {
  a.reg16[14] = a.pop16();
};
table32[95] = function(a) {
  a.reg32s[7] = a.pop32s();
};
table16[96] = function(a) {
  a.pusha16();
};
table32[96] = function(a) {
  a.pusha32();
};
table16[97] = function(a) {
  a.popa16();
};
table32[97] = function(a) {
  a.popa32();
};
table16[98] = table32[98] = function() {
};
table16[99] = table32[99] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.arpl(d, c >> 2 & 14);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table16[100] = table32[100] = function(a) {
  a.seg_prefix(4);
};
table16[101] = table32[101] = function(a) {
  a.seg_prefix(5);
};
table16[102] = table32[102] = function(a) {
  a.operand_size_32 = !a.is_32;
  a.update_operand_size();
  a.do_op();
  a.operand_size_32 = a.is_32;
  a.update_operand_size();
};
table16[103] = table32[103] = function(a) {
  a.address_size_32 = !a.is_32;
  a.update_address_size();
  a.do_op();
  a.address_size_32 = a.is_32;
  a.update_address_size();
};
table16[104] = function(a) {
  a.push16(a.read_imm16());
};
table32[104] = function(a) {
  a.push32(a.read_imm32s());
};
table16[105] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) << 16 >> 16 : a.reg16s[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.imul_reg16(a.read_imm16s(), d);
};
table32[105] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.imul_reg32(a.read_imm32s(), d);
};
table16[106] = function(a) {
  a.push16(a.read_imm8s());
};
table32[106] = function(a) {
  a.push32(a.read_imm8s());
};
table16[107] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) << 16 >> 16 : a.reg16s[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.imul_reg16(a.read_imm8s(), d);
};
table32[107] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.imul_reg32(a.read_imm8s(), d);
};
table16[108] = table32[108] = function(a) {
  insb(a);
};
table16[109] = function(a) {
  insw(a);
};
table32[109] = function(a) {
  insd(a);
};
table16[110] = table32[110] = function(a) {
  outsb(a);
};
table16[111] = function(a) {
  outsw(a);
};
table32[111] = function(a) {
  outsd(a);
};
table16[112] = table32[112] = function(a) {
  a.test_o() && (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[113] = table32[113] = function(a) {
  a.test_o() || (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[114] = table32[114] = function(a) {
  a.test_b() && (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[115] = table32[115] = function(a) {
  a.test_b() || (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[116] = table32[116] = function(a) {
  a.test_z() && (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[117] = table32[117] = function(a) {
  a.test_z() || (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[118] = table32[118] = function(a) {
  a.test_be() && (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[119] = table32[119] = function(a) {
  a.test_be() || (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[120] = table32[120] = function(a) {
  a.test_s() && (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[121] = table32[121] = function(a) {
  a.test_s() || (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[122] = table32[122] = function(a) {
  a.test_p() && (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[123] = table32[123] = function(a) {
  a.test_p() || (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[124] = table32[124] = function(a) {
  a.test_l() && (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[125] = table32[125] = function(a) {
  a.test_l() || (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[126] = table32[126] = function(a) {
  a.test_le() && (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[127] = table32[127] = function(a) {
  a.test_le() || (a.instruction_pointer = a.instruction_pointer + a.read_imm8s() | 0);
  a.instruction_pointer++;
  a.last_instr_jump = !0;
};
table16[128] = table32[128] = function(a) {
  var c = a.read_imm8();
  if (56 === (c & 56)) {
    var d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
    a.sub(d, a.read_imm8(), 7);
  } else {
    var e, f, g;
    192 > c ? (f = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(f)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
    g = 0;
    e = a.read_imm8();
    switch(c >> 3 & 7) {
      case 0:
        g = a.add(d, e, 7);
        break;
      case 1:
        g = a.or(d, e, 7);
        break;
      case 2:
        g = a.adc(d, e, 7);
        break;
      case 3:
        g = a.sbb(d, e, 7);
        break;
      case 4:
        g = a.and(d, e, 7);
        break;
      case 5:
        g = a.sub(d, e, 7);
        break;
      case 6:
        g = a.xor(d, e, 7);
        break;
      case 7:
        g = dbg_assert.bind(this, 0)(d, e);
    }
    192 > c ? a.memory.write8(f, g) : a.reg8[c << 2 & 12 | c >> 2 & 1] = g;
  }
};
table16[129] = function(a) {
  var c = a.read_imm8();
  if (56 === (c & 56)) {
    var d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
    a.sub(d, a.read_imm16(), 15);
  } else {
    var e, f, g = 0, k;
    192 > c ? (d = a.modrm_resolve(c), f = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (g = a.translate_address_write(d + 1), d = a.virt_boundary_read16(f, g)) : d = a.memory.read16(f)) : d = a.reg16[c << 1 & 14];
    k = 0;
    e = a.read_imm16();
    switch(c >> 3 & 7) {
      case 0:
        k = a.add(d, e, 15);
        break;
      case 1:
        k = a.or(d, e, 15);
        break;
      case 2:
        k = a.adc(d, e, 15);
        break;
      case 3:
        k = a.sbb(d, e, 15);
        break;
      case 4:
        k = a.and(d, e, 15);
        break;
      case 5:
        k = a.sub(d, e, 15);
        break;
      case 6:
        k = a.xor(d, e, 15);
        break;
      case 7:
        k = dbg_assert.bind(this, 0)(d, e);
    }
    192 > c ? g ? a.virt_boundary_write16(f, g, k) : a.memory.write16(f, k) : a.reg16[c << 1 & 14] = k;
  }
};
table32[129] = function(a) {
  var c = a.read_imm8();
  if (56 === (c & 56)) {
    var d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
    a.sub(d, a.read_imm32s(), 31);
  } else {
    var e, f, g = 0, k;
    192 > c ? (d = a.modrm_resolve(c), f = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (g = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(f, g)) : d = a.memory.read32s(f)) : d = a.reg32s[c & 7];
    k = 0;
    e = a.read_imm32s();
    switch(c >> 3 & 7) {
      case 0:
        k = a.add(d, e, 31);
        break;
      case 1:
        k = a.or(d, e, 31);
        break;
      case 2:
        k = a.adc(d, e, 31);
        break;
      case 3:
        k = a.sbb(d, e, 31);
        break;
      case 4:
        k = a.and(d, e, 31);
        break;
      case 5:
        k = a.sub(d, e, 31);
        break;
      case 6:
        k = a.xor(d, e, 31);
        break;
      case 7:
        k = dbg_assert.bind(this, 0)(d, e);
    }
    192 > c ? g ? a.virt_boundary_write32(f, g, k) : a.memory.write32(f, k) : a.reg32s[c & 7] = k;
  }
};
table16[130] = table32[130] = function(a) {
  a.table[128](a);
};
table16[131] = function(a) {
  var c = a.read_imm8();
  if (56 === (c & 56)) {
    var d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
    a.sub(d, a.read_imm8s(), 15);
  } else {
    var e, f, g = 0, k;
    192 > c ? (d = a.modrm_resolve(c), f = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (g = a.translate_address_write(d + 1), d = a.virt_boundary_read16(f, g)) : d = a.memory.read16(f)) : d = a.reg16[c << 1 & 14];
    k = 0;
    e = a.read_imm8s();
    switch(c >> 3 & 7) {
      case 0:
        k = a.add(d, e, 15);
        break;
      case 1:
        k = a.or(d, e, 15);
        break;
      case 2:
        k = a.adc(d, e, 15);
        break;
      case 3:
        k = a.sbb(d, e, 15);
        break;
      case 4:
        k = a.and(d, e, 15);
        break;
      case 5:
        k = a.sub(d, e, 15);
        break;
      case 6:
        k = a.xor(d, e, 15);
        break;
      case 7:
        k = dbg_assert.bind(this, 0)(d, e);
    }
    192 > c ? g ? a.virt_boundary_write16(f, g, k) : a.memory.write16(f, k) : a.reg16[c << 1 & 14] = k;
  }
};
table32[131] = function(a) {
  var c = a.read_imm8();
  if (56 === (c & 56)) {
    var d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
    a.sub(d, a.read_imm8s(), 31);
  } else {
    var e, f, g = 0, k;
    192 > c ? (d = a.modrm_resolve(c), f = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (g = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(f, g)) : d = a.memory.read32s(f)) : d = a.reg32s[c & 7];
    k = 0;
    e = a.read_imm8s();
    switch(c >> 3 & 7) {
      case 0:
        k = a.add(d, e, 31);
        break;
      case 1:
        k = a.or(d, e, 31);
        break;
      case 2:
        k = a.adc(d, e, 31);
        break;
      case 3:
        k = a.sbb(d, e, 31);
        break;
      case 4:
        k = a.and(d, e, 31);
        break;
      case 5:
        k = a.sub(d, e, 31);
        break;
      case 6:
        k = a.xor(d, e, 31);
        break;
      case 7:
        k = dbg_assert.bind(this, 0)(d, e);
    }
    192 > c ? g ? a.virt_boundary_write32(f, g, k) : a.memory.write32(f, k) : a.reg32s[c & 7] = k;
  }
};
table16[132] = table32[132] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.and(d, a.reg8[c >> 1 & 12 | c >> 5 & 1], 7);
};
table16[133] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.and(d, a.reg16[c >> 2 & 14], 15);
};
table32[133] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.and(d, a.reg32s[c >> 3 & 7], 31);
};
table16[134] = table32[134] = function(a) {
  var c = a.read_imm8(), d, e;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  d = a.xchg8(d, c);
  192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
};
table16[135] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.xchg16(d, c);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table32[135] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.xchg32(d, c);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table16[136] = table32[136] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = a.reg8[c >> 1 & 12 | c >> 5 & 1];
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table16[137] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = a.reg16[c >> 2 & 14];
  192 > c ? a.safe_write16(d, e) : a.reg16[c << 1 & 14] = e;
};
table32[137] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = a.reg32s[c >> 3 & 7];
  192 > c ? a.safe_write32(d, e) : a.reg32[c & 7] = e;
};
table16[138] = table32[138] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg8[c >> 1 & 12 | c >> 5 & 1] = d;
};
table16[139] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = d;
};
table32[139] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = d;
};
table16[140] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = a.sreg[c >> 3 & 7];
  192 > c ? a.safe_write16(d, e) : a.reg16[c << 1 & 14] = e;
};
table32[140] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = a.sreg[c >> 3 & 7];
  192 > c ? a.safe_write32(d, e) : a.reg32[c & 7] = e;
};
table16[141] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.segment_prefix = 9;
  a.reg16[(c >> 3 & 7) << 1] = a.modrm_resolve(c);
  a.segment_prefix = -1;
};
table32[141] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.segment_prefix = 9;
  a.reg32s[c >> 3 & 7] = a.modrm_resolve(c);
  a.segment_prefix = -1;
};
table16[142] = table32[142] = function(a) {
  var c = a.read_imm8(), d = c >> 3 & 7, c = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.switch_seg(d, c);
};
table16[143] = function(a) {
  var c = a.read_imm8(), d = a.safe_read16(a.get_stack_pointer(0));
  a.stack_reg[a.reg_vsp] += 2;
  192 > c ? (c = a.modrm_resolve(c), a.stack_reg[a.reg_vsp] -= 2, a.safe_write16(c, d), a.stack_reg[a.reg_vsp] += 2) : a.reg16[c << 1 & 14] = d;
};
table32[143] = function(a) {
  var c = a.read_imm8(), d = a.safe_read32s(a.get_stack_pointer(0));
  a.stack_reg[a.reg_vsp] += 4;
  192 > c ? (c = a.modrm_resolve(c), a.stack_reg[a.reg_vsp] -= 4, a.safe_write32(c, d), a.stack_reg[a.reg_vsp] += 4) : a.reg32s[c & 7] = d;
};
table16[144] = table32[144] = function() {
};
table16[145] = function(a) {
  a.xchg16r(2);
};
table32[145] = function(a) {
  a.xchg32r(1);
};
table16[146] = function(a) {
  a.xchg16r(4);
};
table32[146] = function(a) {
  a.xchg32r(2);
};
table16[147] = function(a) {
  a.xchg16r(6);
};
table32[147] = function(a) {
  a.xchg32r(3);
};
table16[148] = function(a) {
  a.xchg16r(8);
};
table32[148] = function(a) {
  a.xchg32r(4);
};
table16[149] = function(a) {
  a.xchg16r(10);
};
table32[149] = function(a) {
  a.xchg32r(5);
};
table16[150] = function(a) {
  a.xchg16r(12);
};
table32[150] = function(a) {
  a.xchg32r(6);
};
table16[151] = function(a) {
  a.xchg16r(14);
};
table32[151] = function(a) {
  a.xchg32r(7);
};
table16[152] = function(a) {
  a.reg16[0] = a.reg8s[0];
};
table32[152] = function(a) {
  a.reg32s[0] = a.reg16s[0];
};
table16[153] = function(a) {
  a.reg16[4] = a.reg16s[0] >> 15;
};
table32[153] = function(a) {
  a.reg32s[2] = a.reg32s[0] >> 31;
};
table16[154] = function(a) {
  var c = a.read_imm16(), d = a.read_imm16();
  a.writable_or_pagefault(a.get_stack_pointer(-4), 4);
  a.push16(a.sreg[1]);
  a.push16(a.get_real_eip());
  a.switch_seg(1, d);
  a.instruction_pointer = a.get_seg(1) + c | 0;
  a.last_instr_jump = !0;
};
table32[154] = function(a) {
  var c = a.read_imm32s(), d = a.read_imm16();
  a.writable_or_pagefault(a.get_stack_pointer(-8), 8);
  a.push32(a.sreg[1]);
  a.push32(a.get_real_eip());
  a.switch_seg(1, d);
  a.instruction_pointer = a.get_seg(1) + c | 0;
  a.last_instr_jump = !0;
};
table16[155] = table32[155] = function(a) {
  10 === (a.cr0 & 10) && a.trigger_nm();
};
table16[156] = function(a) {
  a.flags & 131072 && 3 > a.getiopl() ? a.trigger_gp(0) : (a.load_eflags(), a.push16(a.flags));
};
table32[156] = function(a) {
  a.flags & 131072 && 3 > a.getiopl() ? a.trigger_gp(0) : (a.load_eflags(), a.push32(a.flags & -196609));
};
table16[157] = function(a) {
  a.flags & 131072 && 3 > a.getiopl() && a.trigger_gp(0);
  a.update_eflags(a.flags & -65536 | a.pop16());
  a.handle_irqs();
};
table32[157] = function(a) {
  a.flags & 131072 && 3 > a.getiopl() && a.trigger_gp(0);
  a.update_eflags(a.pop32s());
  a.handle_irqs();
};
table16[158] = table32[158] = function(a) {
  a.flags = a.flags & -256 | a.reg8[1];
  a.flags = a.flags & 4161493 | 2;
  a.flags_changed = 0;
};
table16[159] = table32[159] = function(a) {
  a.load_eflags();
  a.reg8[1] = a.flags;
};
table16[160] = table32[160] = function(a) {
  var c = a.safe_read8(a.read_moffs());
  a.reg8[0] = c;
};
table16[161] = function(a) {
  var c = a.safe_read16(a.read_moffs());
  a.reg16[0] = c;
};
table32[161] = function(a) {
  var c = a.safe_read32s(a.read_moffs());
  a.reg32s[0] = c;
};
table16[162] = table32[162] = function(a) {
  a.safe_write8(a.read_moffs(), a.reg8[0]);
};
table16[163] = function(a) {
  a.safe_write16(a.read_moffs(), a.reg16[0]);
};
table32[163] = function(a) {
  a.safe_write32(a.read_moffs(), a.reg32s[0]);
};
table16[164] = table32[164] = function(a) {
  movsb(a);
};
table16[165] = function(a) {
  movsw(a);
};
table32[165] = function(a) {
  movsd(a);
};
table16[166] = table32[166] = function(a) {
  cmpsb(a);
};
table16[167] = function(a) {
  cmpsw(a);
};
table32[167] = function(a) {
  cmpsd(a);
};
table16[168] = table32[168] = function(a) {
  a.and(a.reg8[0], a.read_imm8(), 7);
};
table16[169] = function(a) {
  a.and(a.reg16[0], a.read_imm16(), 15);
};
table32[169] = function(a) {
  a.and(a.reg32s[0], a.read_imm32s(), 31);
};
table16[170] = table32[170] = function(a) {
  stosb(a);
};
table16[171] = function(a) {
  stosw(a);
};
table32[171] = function(a) {
  stosd(a);
};
table16[172] = table32[172] = function(a) {
  lodsb(a);
};
table16[173] = function(a) {
  lodsw(a);
};
table32[173] = function(a) {
  lodsd(a);
};
table16[174] = table32[174] = function(a) {
  scasb(a);
};
table16[175] = function(a) {
  scasw(a);
};
table32[175] = function(a) {
  scasd(a);
};
table16[176] = table32[176] = function(a) {
  a.reg8[0] = a.read_imm8();
};
table16[177] = table32[177] = function(a) {
  a.reg8[4] = a.read_imm8();
};
table16[178] = table32[178] = function(a) {
  a.reg8[8] = a.read_imm8();
};
table16[179] = table32[179] = function(a) {
  a.reg8[12] = a.read_imm8();
};
table16[180] = table32[180] = function(a) {
  a.reg8[1] = a.read_imm8();
};
table16[181] = table32[181] = function(a) {
  a.reg8[5] = a.read_imm8();
};
table16[182] = table32[182] = function(a) {
  a.reg8[9] = a.read_imm8();
};
table16[183] = table32[183] = function(a) {
  a.reg8[13] = a.read_imm8();
};
table16[184] = function(a) {
  a.reg16[0] = a.read_imm16();
};
table32[184] = function(a) {
  a.reg32s[0] = a.read_imm32s();
};
table16[185] = function(a) {
  a.reg16[2] = a.read_imm16();
};
table32[185] = function(a) {
  a.reg32s[1] = a.read_imm32s();
};
table16[186] = function(a) {
  a.reg16[4] = a.read_imm16();
};
table32[186] = function(a) {
  a.reg32s[2] = a.read_imm32s();
};
table16[187] = function(a) {
  a.reg16[6] = a.read_imm16();
};
table32[187] = function(a) {
  a.reg32s[3] = a.read_imm32s();
};
table16[188] = function(a) {
  a.reg16[8] = a.read_imm16();
};
table32[188] = function(a) {
  a.reg32s[4] = a.read_imm32s();
};
table16[189] = function(a) {
  a.reg16[10] = a.read_imm16();
};
table32[189] = function(a) {
  a.reg32s[5] = a.read_imm32s();
};
table16[190] = function(a) {
  a.reg16[12] = a.read_imm16();
};
table32[190] = function(a) {
  a.reg32s[6] = a.read_imm32s();
};
table16[191] = function(a) {
  a.reg16[14] = a.read_imm16();
};
table32[191] = function(a) {
  a.reg32s[7] = a.read_imm32s();
};
table16[192] = table32[192] = function(a) {
  var c = a.read_imm8(), d, e, f, g;
  192 > c ? (f = a.translate_address_write(a.modrm_resolve(c)), e = a.memory.read8(f)) : e = a.reg8[c << 2 & 12 | c >> 2 & 1];
  g = 0;
  d = a.read_imm8() & 31;
  switch(c >> 3 & 7) {
    case 0:
      g = a.rol8(e, d);
      break;
    case 1:
      g = a.ror8(e, d);
      break;
    case 2:
      g = a.rcl8(e, d);
      break;
    case 3:
      g = a.rcr8(e, d);
      break;
    case 4:
      g = a.shl8(e, d);
      break;
    case 5:
      g = a.shr8(e, d);
      break;
    case 6:
      g = a.shl8(e, d);
      break;
    case 7:
      g = a.sar8(e, d);
  }
  192 > c ? a.memory.write8(f, g) : a.reg8[c << 2 & 12 | c >> 2 & 1] = g;
};
table16[193] = function(a) {
  var c = a.read_imm8(), d, e, f, g = 0, k;
  192 > c ? (d = a.modrm_resolve(c), f = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (g = a.translate_address_write(d + 1), e = a.virt_boundary_read16(f, g)) : e = a.memory.read16(f)) : e = a.reg16[c << 1 & 14];
  k = 0;
  d = a.read_imm8() & 31;
  switch(c >> 3 & 7) {
    case 0:
      k = a.rol16(e, d);
      break;
    case 1:
      k = a.ror16(e, d);
      break;
    case 2:
      k = a.rcl16(e, d);
      break;
    case 3:
      k = a.rcr16(e, d);
      break;
    case 4:
      k = a.shl16(e, d);
      break;
    case 5:
      k = a.shr16(e, d);
      break;
    case 6:
      k = a.shl16(e, d);
      break;
    case 7:
      k = a.sar16(e, d);
  }
  192 > c ? g ? a.virt_boundary_write16(f, g, k) : a.memory.write16(f, k) : a.reg16[c << 1 & 14] = k;
};
table32[193] = function(a) {
  var c = a.read_imm8(), d, e, f, g = 0, k;
  192 > c ? (d = a.modrm_resolve(c), f = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (g = a.translate_address_write(d + 3), e = a.virt_boundary_read32s(f, g)) : e = a.memory.read32s(f)) : e = a.reg32s[c & 7];
  k = 0;
  d = a.read_imm8() & 31;
  switch(c >> 3 & 7) {
    case 0:
      k = a.rol32(e, d);
      break;
    case 1:
      k = a.ror32(e, d);
      break;
    case 2:
      k = a.rcl32(e, d);
      break;
    case 3:
      k = a.rcr32(e, d);
      break;
    case 4:
      k = a.shl32(e, d);
      break;
    case 5:
      k = a.shr32(e, d);
      break;
    case 6:
      k = a.shl32(e, d);
      break;
    case 7:
      k = a.sar32(e, d);
  }
  192 > c ? g ? a.virt_boundary_write32(f, g, k) : a.memory.write32(f, k) : a.reg32s[c & 7] = k;
};
table16[194] = function(a) {
  var c = a.read_imm16();
  a.instruction_pointer = a.get_seg(1) + a.pop16() | 0;
  a.stack_reg[a.reg_vsp] += c;
  a.last_instr_jump = !0;
};
table32[194] = function(a) {
  var c = a.read_imm16();
  a.instruction_pointer = a.get_seg(1) + a.pop32s() | 0;
  a.stack_reg[a.reg_vsp] += c;
  a.last_instr_jump = !0;
};
table16[195] = function(a) {
  a.instruction_pointer = a.get_seg(1) + a.pop16() | 0;
  a.last_instr_jump = !0;
};
table32[195] = function(a) {
  a.instruction_pointer = a.get_seg(1) + a.pop32s() | 0;
  a.last_instr_jump = !0;
};
table16[196] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss16(0, a.modrm_resolve(c), c >> 2 & 14);
};
table32[196] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss32(0, a.modrm_resolve(c), c >> 3 & 7);
};
table16[197] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss16(3, a.modrm_resolve(c), c >> 2 & 14);
};
table32[197] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss32(3, a.modrm_resolve(c), c >> 3 & 7);
};
table16[198] = table32[198] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = a.read_imm8();
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table16[199] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = a.read_imm16();
  192 > c ? a.safe_write16(d, e) : a.reg16[c << 1 & 14] = e;
};
table32[199] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = a.read_imm32s();
  192 > c ? a.safe_write32(d, e) : a.reg32[c & 7] = e;
};
table16[200] = function(a) {
  a.enter16();
};
table32[200] = function(a) {
  a.enter32();
};
table16[201] = function(a) {
  a.stack_reg[a.reg_vsp] = a.stack_reg[a.reg_vbp];
  a.reg16[10] = a.pop16();
};
table32[201] = function(a) {
  a.stack_reg[a.reg_vsp] = a.stack_reg[a.reg_vbp];
  a.reg32s[5] = a.pop32s();
};
table16[202] = function(a) {
  a.translate_address_read(a.get_seg(2) + a.stack_reg[a.reg_vsp] + 4);
  var c = a.read_imm16(), d = a.pop16();
  a.switch_seg(1, a.pop16());
  a.instruction_pointer = a.get_seg(1) + d | 0;
  a.stack_reg[a.reg_vsp] += c;
  a.last_instr_jump = !0;
};
table32[202] = function(a) {
  a.translate_address_read(a.get_seg(2) + a.stack_reg[a.reg_vsp] + 8);
  var c = a.read_imm16(), d = a.pop32s();
  a.switch_seg(1, a.pop32s() & 65535);
  a.instruction_pointer = a.get_seg(1) + d | 0;
  a.stack_reg[a.reg_vsp] += c;
  a.last_instr_jump = !0;
};
table16[203] = function(a) {
  a.translate_address_read(a.get_seg(2) + a.stack_reg[a.reg_vsp] + 4);
  var c = a.pop16();
  a.switch_seg(1, a.pop16());
  a.instruction_pointer = a.get_seg(1) + c | 0;
  a.last_instr_jump = !0;
};
table32[203] = function(a) {
  a.translate_address_read(a.get_seg(2) + a.stack_reg[a.reg_vsp] + 8);
  var c = a.pop32s();
  a.switch_seg(1, a.pop32s() & 65535);
  a.instruction_pointer = a.get_seg(1) + c | 0;
  a.last_instr_jump = !0;
};
table16[204] = table32[204] = function(a) {
  a.call_interrupt_vector(3, !0, !1);
};
table16[205] = table32[205] = function(a) {
  var c = a.read_imm8();
  a.call_interrupt_vector(c, !0, !1);
};
table16[206] = table32[206] = function(a) {
  a.getof() && a.call_interrupt_vector(4, !0, !1);
};
table16[207] = function(a) {
  a.iret16();
};
table32[207] = function(a) {
  a.iret32();
};
table16[208] = table32[208] = function(a) {
  var c = a.read_imm8(), d, e, f;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  f = 0;
  switch(c >> 3 & 7) {
    case 0:
      f = a.rol8(d, 1);
      break;
    case 1:
      f = a.ror8(d, 1);
      break;
    case 2:
      f = a.rcl8(d, 1);
      break;
    case 3:
      f = a.rcr8(d, 1);
      break;
    case 4:
      f = a.shl8(d, 1);
      break;
    case 5:
      f = a.shr8(d, 1);
      break;
    case 6:
      f = a.shl8(d, 1);
      break;
    case 7:
      f = a.sar8(d, 1);
  }
  192 > c ? a.memory.write8(e, f) : a.reg8[c << 2 & 12 | c >> 2 & 1] = f;
};
table16[209] = function(a) {
  var c = a.read_imm8(), d, e, f = 0, g;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  g = 0;
  switch(c >> 3 & 7) {
    case 0:
      g = a.rol16(d, 1);
      break;
    case 1:
      g = a.ror16(d, 1);
      break;
    case 2:
      g = a.rcl16(d, 1);
      break;
    case 3:
      g = a.rcr16(d, 1);
      break;
    case 4:
      g = a.shl16(d, 1);
      break;
    case 5:
      g = a.shr16(d, 1);
      break;
    case 6:
      g = a.shl16(d, 1);
      break;
    case 7:
      g = a.sar16(d, 1);
  }
  192 > c ? f ? a.virt_boundary_write16(e, f, g) : a.memory.write16(e, g) : a.reg16[c << 1 & 14] = g;
};
table32[209] = function(a) {
  var c = a.read_imm8(), d, e, f = 0, g;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  g = 0;
  switch(c >> 3 & 7) {
    case 0:
      g = a.rol32(d, 1);
      break;
    case 1:
      g = a.ror32(d, 1);
      break;
    case 2:
      g = a.rcl32(d, 1);
      break;
    case 3:
      g = a.rcr32(d, 1);
      break;
    case 4:
      g = a.shl32(d, 1);
      break;
    case 5:
      g = a.shr32(d, 1);
      break;
    case 6:
      g = a.shl32(d, 1);
      break;
    case 7:
      g = a.sar32(d, 1);
  }
  192 > c ? f ? a.virt_boundary_write32(e, f, g) : a.memory.write32(e, g) : a.reg32s[c & 7] = g;
};
table16[210] = table32[210] = function(a) {
  var c = a.read_imm8(), d, e, f, g;
  192 > c ? (f = a.translate_address_write(a.modrm_resolve(c)), e = a.memory.read8(f)) : e = a.reg8[c << 2 & 12 | c >> 2 & 1];
  g = 0;
  d = a.reg8[4] & 31;
  switch(c >> 3 & 7) {
    case 0:
      g = a.rol8(e, d);
      break;
    case 1:
      g = a.ror8(e, d);
      break;
    case 2:
      g = a.rcl8(e, d);
      break;
    case 3:
      g = a.rcr8(e, d);
      break;
    case 4:
      g = a.shl8(e, d);
      break;
    case 5:
      g = a.shr8(e, d);
      break;
    case 6:
      g = a.shl8(e, d);
      break;
    case 7:
      g = a.sar8(e, d);
  }
  192 > c ? a.memory.write8(f, g) : a.reg8[c << 2 & 12 | c >> 2 & 1] = g;
};
table16[211] = function(a) {
  var c = a.read_imm8(), d, e, f, g = 0, k;
  192 > c ? (d = a.modrm_resolve(c), f = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (g = a.translate_address_write(d + 1), e = a.virt_boundary_read16(f, g)) : e = a.memory.read16(f)) : e = a.reg16[c << 1 & 14];
  k = 0;
  d = a.reg8[4] & 31;
  switch(c >> 3 & 7) {
    case 0:
      k = a.rol16(e, d);
      break;
    case 1:
      k = a.ror16(e, d);
      break;
    case 2:
      k = a.rcl16(e, d);
      break;
    case 3:
      k = a.rcr16(e, d);
      break;
    case 4:
      k = a.shl16(e, d);
      break;
    case 5:
      k = a.shr16(e, d);
      break;
    case 6:
      k = a.shl16(e, d);
      break;
    case 7:
      k = a.sar16(e, d);
  }
  192 > c ? g ? a.virt_boundary_write16(f, g, k) : a.memory.write16(f, k) : a.reg16[c << 1 & 14] = k;
};
table32[211] = function(a) {
  var c = a.read_imm8(), d, e, f, g = 0, k;
  192 > c ? (d = a.modrm_resolve(c), f = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (g = a.translate_address_write(d + 3), e = a.virt_boundary_read32s(f, g)) : e = a.memory.read32s(f)) : e = a.reg32s[c & 7];
  k = 0;
  d = a.reg8[4] & 31;
  switch(c >> 3 & 7) {
    case 0:
      k = a.rol32(e, d);
      break;
    case 1:
      k = a.ror32(e, d);
      break;
    case 2:
      k = a.rcl32(e, d);
      break;
    case 3:
      k = a.rcr32(e, d);
      break;
    case 4:
      k = a.shl32(e, d);
      break;
    case 5:
      k = a.shr32(e, d);
      break;
    case 6:
      k = a.shl32(e, d);
      break;
    case 7:
      k = a.sar32(e, d);
  }
  192 > c ? g ? a.virt_boundary_write32(f, g, k) : a.memory.write32(f, k) : a.reg32s[c & 7] = k;
};
table16[212] = table32[212] = function(a) {
  a.bcd_aam();
};
table16[213] = table32[213] = function(a) {
  a.bcd_aad();
};
table16[214] = table32[214] = function(a) {
  a.reg8[0] = -a.getcf();
};
table16[215] = table32[215] = function(a) {
  a.reg8[0] = a.address_size_32 ? a.safe_read8(a.get_seg_prefix(3) + a.reg32s[3] + a.reg8[0]) : a.safe_read8(a.get_seg_prefix(3) + a.reg16[6] + a.reg8[0]);
};
table16[216] = table32[216] = function(a) {
  var c = a.read_imm8();
  a.cr0 & 12 && a.trigger_nm();
  192 > c ? a.fpu.op_D8_mem(c, a.modrm_resolve(c)) : a.fpu.op_D8_reg(c);
};
table16[217] = table32[217] = function(a) {
  var c = a.read_imm8();
  a.cr0 & 12 && a.trigger_nm();
  192 > c ? a.fpu.op_D9_mem(c, a.modrm_resolve(c)) : a.fpu.op_D9_reg(c);
};
table16[218] = table32[218] = function(a) {
  var c = a.read_imm8();
  a.cr0 & 12 && a.trigger_nm();
  192 > c ? a.fpu.op_DA_mem(c, a.modrm_resolve(c)) : a.fpu.op_DA_reg(c);
};
table16[219] = table32[219] = function(a) {
  var c = a.read_imm8();
  a.cr0 & 12 && a.trigger_nm();
  192 > c ? a.fpu.op_DB_mem(c, a.modrm_resolve(c)) : a.fpu.op_DB_reg(c);
};
table16[220] = table32[220] = function(a) {
  var c = a.read_imm8();
  a.cr0 & 12 && a.trigger_nm();
  192 > c ? a.fpu.op_DC_mem(c, a.modrm_resolve(c)) : a.fpu.op_DC_reg(c);
};
table16[221] = table32[221] = function(a) {
  var c = a.read_imm8();
  a.cr0 & 12 && a.trigger_nm();
  192 > c ? a.fpu.op_DD_mem(c, a.modrm_resolve(c)) : a.fpu.op_DD_reg(c);
};
table16[222] = table32[222] = function(a) {
  var c = a.read_imm8();
  a.cr0 & 12 && a.trigger_nm();
  192 > c ? a.fpu.op_DE_mem(c, a.modrm_resolve(c)) : a.fpu.op_DE_reg(c);
};
table16[223] = table32[223] = function(a) {
  var c = a.read_imm8();
  a.cr0 & 12 && a.trigger_nm();
  192 > c ? a.fpu.op_DF_mem(c, a.modrm_resolve(c)) : a.fpu.op_DF_reg(c);
};
table16[224] = table32[224] = function(a) {
  a.loopne();
};
table16[225] = table32[225] = function(a) {
  a.loope();
};
table16[226] = table32[226] = function(a) {
  a.loop();
};
table16[227] = table32[227] = function(a) {
  a.jcxz();
};
table16[228] = table32[228] = function(a) {
  var c = a.read_imm8();
  a.test_privileges_for_io(c, 1);
  a.reg8[0] = a.io.port_read8(c);
};
table16[229] = function(a) {
  var c = a.read_imm8();
  a.test_privileges_for_io(c, 2);
  a.reg16[0] = a.io.port_read16(c);
};
table32[229] = function(a) {
  var c = a.read_imm8();
  a.test_privileges_for_io(c, 4);
  a.reg32s[0] = a.io.port_read32(c);
};
table16[230] = table32[230] = function(a) {
  var c = a.read_imm8();
  a.test_privileges_for_io(c, 1);
  a.io.port_write8(c, a.reg8[0]);
};
table16[231] = function(a) {
  var c = a.read_imm8();
  a.test_privileges_for_io(c, 2);
  a.io.port_write16(c, a.reg16[0]);
};
table32[231] = function(a) {
  var c = a.read_imm8();
  a.test_privileges_for_io(c, 4);
  a.io.port_write32(c, a.reg32s[0]);
};
table16[232] = function(a) {
  var c = a.read_imm16s();
  a.push16(a.get_real_eip());
  a.jmp_rel16(c);
  a.last_instr_jump = !0;
};
table32[232] = function(a) {
  var c = a.read_imm32s();
  a.push32(a.get_real_eip());
  a.instruction_pointer = a.instruction_pointer + c | 0;
  a.last_instr_jump = !0;
};
table16[233] = function(a) {
  var c = a.read_imm16s();
  a.jmp_rel16(c);
  a.last_instr_jump = !0;
};
table32[233] = function(a) {
  var c = a.read_imm32s();
  a.instruction_pointer = a.instruction_pointer + c | 0;
  a.last_instr_jump = !0;
};
table16[234] = function(a) {
  var c = a.read_imm16();
  a.switch_seg(1, a.read_imm16());
  a.instruction_pointer = c + a.get_seg(1) | 0;
  a.last_instr_jump = !0;
};
table32[234] = function(a) {
  var c = a.read_imm32s();
  a.switch_seg(1, a.read_imm16());
  a.instruction_pointer = c + a.get_seg(1) | 0;
  a.last_instr_jump = !0;
};
table16[235] = table32[235] = function(a) {
  var c = a.read_imm8s();
  a.instruction_pointer = a.instruction_pointer + c | 0;
  a.last_instr_jump = !0;
};
table16[236] = table32[236] = function(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 1);
  a.reg8[0] = a.io.port_read8(c);
};
table16[237] = function(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 2);
  a.reg16[0] = a.io.port_read16(c);
};
table32[237] = function(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 4);
  a.reg32s[0] = a.io.port_read32(c);
};
table16[238] = table32[238] = function(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 1);
  a.io.port_write8(c, a.reg8[0]);
};
table16[239] = function(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 2);
  a.io.port_write16(c, a.reg16[0]);
};
table32[239] = function(a) {
  var c = a.reg16[4];
  a.test_privileges_for_io(c, 4);
  a.io.port_write32(c, a.reg32s[0]);
};
table16[240] = table32[240] = function(a) {
  a.do_op();
};
table16[241] = table32[241] = function(a) {
  throw a.debug.unimpl("int1 instruction");
};
table16[242] = table32[242] = function(a) {
  a.repeat_string_prefix = 1;
  a.do_op();
  a.repeat_string_prefix = 0;
};
table16[243] = table32[243] = function(a) {
  a.repeat_string_prefix = 2;
  a.do_op();
  a.repeat_string_prefix = 0;
};
table16[244] = table32[244] = function(a) {
  a.hlt_op();
};
table16[245] = table32[245] = function(a) {
  a.flags = (a.flags | 1) ^ a.getcf();
  a.flags_changed &= -2;
};
table16[246] = table32[246] = function(a) {
  var c = a.read_imm8();
  switch(c >> 3 & 7) {
    case 0:
      var d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
      a.and(d, a.read_imm8(), 7);
      break;
    case 1:
      d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
      a.and(d, a.read_imm8(), 7);
      break;
    case 2:
      var e;
      192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
      d = ~d;
      192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
      break;
    case 3:
      192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
      d = a.neg(d, 7);
      192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
      break;
    case 4:
      d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
      a.mul8(d);
      break;
    case 5:
      192 > c ? d = a.safe_read8(a.modrm_resolve(c)) << 24 >> 24 : d = a.reg8s[c << 2 & 12 | c >> 2 & 1];
      a.imul8(d);
      break;
    case 6:
      d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
      a.div8(d);
      break;
    case 7:
      192 > c ? d = a.safe_read8(a.modrm_resolve(c)) << 24 >> 24 : d = a.reg8s[c << 2 & 12 | c >> 2 & 1], a.idiv8(d);
  }
};
table16[247] = function(a) {
  var c = a.read_imm8();
  switch(c >> 3 & 7) {
    case 0:
      var d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
      a.and(d, a.read_imm16(), 15);
      break;
    case 1:
      d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
      a.and(d, a.read_imm16(), 15);
      break;
    case 2:
      var e, f = 0;
      192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
      d = ~d;
      192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
      break;
    case 3:
      f = 0;
      192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
      d = a.neg(d, 15);
      192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
      break;
    case 4:
      d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
      a.mul16(d);
      break;
    case 5:
      192 > c ? d = a.safe_read16(a.modrm_resolve(c)) << 16 >> 16 : d = a.reg16s[c << 1 & 14];
      a.imul16(d);
      break;
    case 6:
      d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
      a.div16(d);
      break;
    case 7:
      192 > c ? d = a.safe_read16(a.modrm_resolve(c)) << 16 >> 16 : d = a.reg16s[c << 1 & 14], a.idiv16(d);
  }
};
table32[247] = function(a) {
  var c = a.read_imm8();
  switch(c >> 3 & 7) {
    case 0:
      var d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
      a.and(d, a.read_imm32s(), 31);
      break;
    case 1:
      d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
      a.and(d, a.read_imm32s(), 31);
      break;
    case 2:
      var e, f = 0;
      192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
      d = ~d;
      192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
      break;
    case 3:
      f = 0;
      192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
      d = a.neg(d, 31);
      192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
      break;
    case 4:
      192 > c ? d = a.safe_read32s(a.modrm_resolve(c)) >>> 0 : d = a.reg32[c & 7];
      a.mul32(d);
      break;
    case 5:
      d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
      a.imul32(d);
      break;
    case 6:
      192 > c ? d = a.safe_read32s(a.modrm_resolve(c)) >>> 0 : d = a.reg32[c & 7];
      a.div32(d);
      break;
    case 7:
      d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7], a.idiv32(d);
  }
};
table16[248] = table32[248] = function(a) {
  a.flags &= -2;
  a.flags_changed &= -2;
};
table16[249] = table32[249] = function(a) {
  a.flags |= 1;
  a.flags_changed &= -2;
};
table16[250] = table32[250] = function(a) {
  !a.protected_mode || (a.flags & 131072 ? 3 === a.getiopl() : a.getiopl() >= a.cpl) ? a.flags &= -513 : 3 > a.getiopl() && (a.flags & 131072 ? a.cr4 & 1 : 3 === a.cpl && a.cr4 & 2) ? a.flags &= -524289 : a.trigger_gp(0);
};
table16[251] = table32[251] = function(a) {
  !a.protected_mode || (a.flags & 131072 ? 3 === a.getiopl() : a.getiopl() >= a.cpl) ? (a.flags |= 512, a.cycle(), a.handle_irqs()) : 3 > a.getiopl() && 0 === (a.flags & 1048576) && (a.flags & 131072 ? a.cr4 & 1 : 3 === a.cpl && a.cr4 & 2) ? a.flags |= 524288 : a.trigger_gp(0);
};
table16[252] = table32[252] = function(a) {
  a.flags &= -1025;
};
table16[253] = table32[253] = function(a) {
  a.flags |= 1024;
};
table16[254] = table32[254] = function(a) {
  var c = a.read_imm8(), d = c & 56;
  if (0 === d) {
    var e;
    192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
    d = a.inc(d, 7);
    192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
  } else {
    8 === d ? (192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1], d = a.dec(d, 7), 192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d) : a.trigger_ud();
  }
};
table16[255] = function(a) {
  var c = a.read_imm8();
  switch(c >> 3 & 7) {
    case 0:
      var d, e, f = 0;
      192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
      d = a.inc(d, 15);
      192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
      break;
    case 1:
      f = 0;
      192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
      d = a.dec(d, 15);
      192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
      break;
    case 2:
      d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
      a.push16(a.get_real_eip());
      a.instruction_pointer = a.get_seg(1) + d | 0;
      a.last_instr_jump = !0;
      break;
    case 3:
      192 <= c && a.trigger_ud();
      d = a.modrm_resolve(c);
      c = a.safe_read16(d + 2);
      e = a.safe_read16(d);
      a.writable_or_pagefault(a.get_stack_pointer(-4), 4);
      a.push16(a.sreg[1]);
      a.push16(a.get_real_eip());
      a.switch_seg(1, c);
      a.instruction_pointer = a.get_seg(1) + e | 0;
      a.last_instr_jump = !0;
      break;
    case 4:
      d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
      a.instruction_pointer = a.get_seg(1) + d | 0;
      a.last_instr_jump = !0;
      break;
    case 5:
      192 <= c && a.trigger_ud();
      d = a.modrm_resolve(c);
      c = a.safe_read16(d + 2);
      e = a.safe_read16(d);
      a.switch_seg(1, c);
      a.instruction_pointer = a.get_seg(1) + e | 0;
      a.last_instr_jump = !0;
      break;
    case 6:
      d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
      a.push16(d);
      break;
    case 7:
      a.trigger_ud();
  }
};
table32[255] = function(a) {
  var c = a.read_imm8();
  switch(c >> 3 & 7) {
    case 0:
      var d, e, f = 0;
      192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
      d = a.inc(d, 31);
      192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
      break;
    case 1:
      f = 0;
      192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
      d = a.dec(d, 31);
      192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
      break;
    case 2:
      d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
      a.push32(a.get_real_eip());
      a.instruction_pointer = a.get_seg(1) + d | 0;
      a.last_instr_jump = !0;
      break;
    case 3:
      192 <= c && a.trigger_ud();
      d = a.modrm_resolve(c);
      c = a.safe_read16(d + 4);
      e = a.safe_read32s(d);
      a.writable_or_pagefault(a.get_stack_pointer(-8), 8);
      a.push32(a.sreg[1]);
      a.push32(a.get_real_eip());
      a.switch_seg(1, c);
      a.instruction_pointer = a.get_seg(1) + e | 0;
      a.last_instr_jump = !0;
      break;
    case 4:
      d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
      a.instruction_pointer = a.get_seg(1) + d | 0;
      a.last_instr_jump = !0;
      break;
    case 5:
      192 <= c && a.trigger_ud();
      d = a.modrm_resolve(c);
      c = a.safe_read16(d + 4);
      e = a.safe_read32s(d);
      a.switch_seg(1, c);
      a.instruction_pointer = a.get_seg(1) + e | 0;
      a.last_instr_jump = !0;
      break;
    case 6:
      d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
      a.push32(d);
      break;
    case 7:
      a.trigger_ud();
  }
};
table0F_16[0] = table0F_32[0] = function(a) {
  var c = a.read_imm8();
  a.protected_mode || a.trigger_ud();
  a.cpl && a.trigger_gp(0);
  switch(c >> 3 & 7) {
    case 0:
      if (192 > c) {
        var d = a.modrm_resolve(c)
      }
      var e = a.sreg[7];
      192 > c ? a.safe_write16(d, e) : a.reg16[c << 1 & 14] = e;
      break;
    case 1:
      192 > c && (d = a.modrm_resolve(c));
      e = a.sreg[6];
      192 > c ? a.safe_write16(d, e) : a.reg16[c << 1 & 14] = e;
      break;
    case 2:
      e = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
      a.load_ldt(e);
      break;
    case 3:
      e = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
      a.load_tr(e);
      break;
    default:
      a.trigger_ud();
  }
};
table0F_16[1] = table0F_32[1] = function(a) {
  var c = a.read_imm8();
  a.cpl && a.trigger_gp(0);
  var d = c >> 3 & 7;
  if (4 === d) {
    if (192 > c) {
      var e = a.modrm_resolve(c)
    }
    d = a.cr0;
    192 > c ? a.safe_write16(e, d) : a.reg16[c << 1 & 14] = d;
  } else {
    if (6 === d) {
      d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14], a.cr0 = a.cr0 & -16 | d & 15, a.protected_mode && (a.cr0 |= 1), a.cr0_changed();
    } else {
      switch(192 <= c && a.trigger_ud(), 2 !== d && 3 !== d || !a.protected_mode || (a.segment_prefix = 9), e = a.modrm_resolve(c), a.segment_prefix = -1, d) {
        case 0:
          a.writable_or_pagefault(e, 6);
          a.safe_write16(e, a.gdtr_size);
          a.safe_write32(e + 2, a.gdtr_offset);
          break;
        case 1:
          a.writable_or_pagefault(e, 6);
          a.safe_write16(e, a.idtr_size);
          a.safe_write32(e + 2, a.idtr_offset);
          break;
        case 2:
          c = a.safe_read16(e);
          e = a.safe_read32s(e + 2);
          a.gdtr_size = c;
          a.gdtr_offset = e;
          a.operand_size_32 || (a.gdtr_offset &= 16777215);
          break;
        case 3:
          c = a.safe_read16(e);
          e = a.safe_read32s(e + 2);
          a.idtr_size = c;
          a.idtr_offset = e;
          a.operand_size_32 || (a.idtr_offset &= 16777215);
          break;
        case 7:
          a.invlpg(e);
          break;
        default:
          a.trigger_ud();
      }
    }
  }
};
table0F_16[2] = table0F_32[2] = function(a) {
  a.read_imm8();
  a.trigger_ud();
};
table0F_16[3] = table0F_32[3] = function(a) {
  a.read_imm8();
  a.trigger_ud();
};
table0F_16[4] = table0F_32[4] = function(a) {
  a.trigger_ud();
};
table0F_16[5] = table0F_32[5] = function(a) {
  a.trigger_ud();
};
table0F_16[6] = table0F_32[6] = function(a) {
  a.cpl ? a.trigger_gp(0) : a.cr0 &= -9;
};
table0F_16[7] = table0F_32[7] = function(a) {
  a.trigger_ud();
};
table0F_16[8] = table0F_32[8] = function(a) {
  a.trigger_ud();
};
table0F_16[9] = table0F_32[9] = function(a) {
  a.cpl && a.trigger_gp(0);
};
table0F_16[10] = table0F_32[10] = function(a) {
  a.trigger_ud();
};
table0F_16[11] = table0F_32[11] = function(a) {
  a.trigger_ud();
};
table0F_16[12] = table0F_32[12] = function(a) {
  a.trigger_ud();
};
table0F_16[13] = table0F_32[13] = function(a) {
  a.trigger_ud();
};
table0F_16[14] = table0F_32[14] = function(a) {
  a.trigger_ud();
};
table0F_16[15] = table0F_32[15] = function(a) {
  a.trigger_ud();
};
table0F_16[16] = table0F_32[16] = function(a) {
  a.trigger_ud();
};
table0F_16[17] = table0F_32[17] = function(a) {
  a.trigger_ud();
};
table0F_16[18] = table0F_32[18] = function(a) {
  a.trigger_ud();
};
table0F_16[19] = table0F_32[19] = function(a) {
  a.trigger_ud();
};
table0F_16[20] = table0F_32[20] = function(a) {
  a.trigger_ud();
};
table0F_16[21] = table0F_32[21] = function(a) {
  a.trigger_ud();
};
table0F_16[22] = table0F_32[22] = function(a) {
  a.trigger_ud();
};
table0F_16[23] = table0F_32[23] = function(a) {
  a.trigger_ud();
};
table0F_16[24] = table0F_32[24] = function(a) {
  var c = a.read_imm8();
  192 > c && a.modrm_resolve(c);
};
table0F_16[25] = table0F_32[25] = function(a) {
  a.trigger_ud();
};
table0F_16[26] = table0F_32[26] = function(a) {
  a.trigger_ud();
};
table0F_16[27] = table0F_32[27] = function(a) {
  a.trigger_ud();
};
table0F_16[28] = table0F_32[28] = function(a) {
  a.trigger_ud();
};
table0F_16[29] = table0F_32[29] = function(a) {
  a.trigger_ud();
};
table0F_16[30] = table0F_32[30] = function(a) {
  a.trigger_ud();
};
table0F_16[31] = table0F_32[31] = function(a) {
  a.trigger_ud();
};
table0F_16[32] = table0F_32[32] = function(a) {
  var c = a.read_imm8();
  a.cpl && a.trigger_gp(0);
  switch(c >> 3 & 7) {
    case 0:
      a.reg32s[c & 7] = a.cr0;
      break;
    case 2:
      a.reg32s[c & 7] = a.cr2;
      break;
    case 3:
      a.reg32s[c & 7] = a.cr3;
      break;
    case 4:
      a.reg32s[c & 7] = a.cr4;
      break;
    default:
      a.trigger_ud();
  }
};
table0F_16[33] = table0F_32[33] = function(a) {
  var c = a.read_imm8();
  a.cpl && a.trigger_gp(0);
  a.reg32s[c & 7] = a.dreg[c >> 3 & 7];
};
table0F_16[34] = table0F_32[34] = function(a) {
  var c = a.read_imm8();
  a.cpl && a.trigger_gp(0);
  var d = a.reg32s[c & 7];
  switch(c >> 3 & 7) {
    case 0:
      a.cr0 = d;
      if (-2147483648 === (a.cr0 & -2147483647)) {
        throw a.debug.unimpl("#GP handler");
      }
      a.cr0_changed();
      break;
    case 2:
      a.cr2 = d;
      break;
    case 3:
      a.cr3 = d;
      a.clear_tlb();
      break;
    case 4:
      d & -3565568 && a.trigger_gp(0);
      (a.cr4 ^ d) & 128 && (d & 128 ? a.clear_tlb() : a.full_clear_tlb());
      a.cr4 = d;
      a.page_size_extensions = a.cr4 & 16 ? 128 : 0;
      if (a.cr4 & 32) {
        throw a.debug.unimpl("PAE");
      }
      break;
    default:
      a.trigger_ud();
  }
};
table0F_16[35] = table0F_32[35] = function(a) {
  var c = a.read_imm8();
  a.cpl && a.trigger_gp(0);
  a.dreg[c >> 3 & 7] = a.reg32s[c & 7];
};
table0F_16[36] = table0F_32[36] = function(a) {
  a.trigger_ud();
};
table0F_16[37] = table0F_32[37] = function(a) {
  a.trigger_ud();
};
table0F_16[38] = table0F_32[38] = function(a) {
  a.trigger_ud();
};
table0F_16[39] = table0F_32[39] = function(a) {
  a.trigger_ud();
};
table0F_16[40] = table0F_32[40] = function(a) {
  a.trigger_ud();
};
table0F_16[41] = table0F_32[41] = function(a) {
  a.trigger_ud();
};
table0F_16[42] = table0F_32[42] = function(a) {
  a.trigger_ud();
};
table0F_16[43] = table0F_32[43] = function(a) {
  a.trigger_ud();
};
table0F_16[44] = table0F_32[44] = function(a) {
  a.trigger_ud();
};
table0F_16[45] = table0F_32[45] = function(a) {
  a.trigger_ud();
};
table0F_16[46] = table0F_32[46] = function(a) {
  a.trigger_ud();
};
table0F_16[47] = table0F_32[47] = function(a) {
  a.trigger_ud();
};
table0F_16[48] = table0F_32[48] = function(a) {
  a.cpl && a.trigger_gp(0);
  var c = a.reg32s[0];
  switch(a.reg32s[1]) {
    case 372:
      a.sysenter_cs = c & 65535;
      break;
    case 374:
      a.sysenter_eip = c;
      break;
    case 373:
      a.sysenter_esp = c;
  }
};
table0F_16[49] = table0F_32[49] = function(a) {
  if (a.cpl && a.cr4 & 4) {
    a.trigger_gp(0);
  } else {
    var c = v86.microtick() - a.tsc_offset;
    a.reg32s[0] = 8192 * c;
    a.reg32s[2] = 1.9073486328125E-6 * c;
  }
};
table0F_16[50] = table0F_32[50] = function(a) {
  a.cpl && a.trigger_gp(0);
  var c = 0;
  switch(a.reg32s[1]) {
    case 372:
      c = a.sysenter_cs;
      break;
    case 374:
      c = a.sysenter_eip;
      break;
    case 373:
      c = a.sysenter_esp;
  }
  a.reg32s[0] = c;
  a.reg32s[2] = 0;
};
table0F_16[51] = table0F_32[51] = function(a) {
  a.trigger_ud();
};
table0F_16[52] = table0F_32[52] = function(a) {
  var c = a.sysenter_cs & 65532;
  a.protected_mode && 0 !== c || a.trigger_gp(0);
  a.flags &= -131585;
  a.instruction_pointer = a.sysenter_eip;
  a.reg32s[4] = a.sysenter_esp;
  a.sreg[1] = c;
  a.segment_is_null[1] = 0;
  a.segment_limits[1] = -1;
  a.segment_offsets[1] = 0;
  a.is_32 || a.update_cs_size(!0);
  a.cpl = 0;
  a.cpl_changed();
  a.sreg[2] = c + 8;
  a.segment_is_null[2] = 0;
  a.segment_limits[2] = -1;
  a.segment_offsets[2] = 0;
  a.stack_size_32 = !0;
  a.stack_reg = a.reg32s;
  a.reg_vsp = 4;
  a.reg_vbp = 5;
};
table0F_16[53] = table0F_32[53] = function(a) {
  var c = a.sysenter_cs & 65532;
  a.protected_mode && !a.cpl && 0 !== c || a.trigger_gp(0);
  a.instruction_pointer = a.reg32s[2];
  a.reg32s[4] = a.reg32s[1];
  a.sreg[1] = c + 16 | 3;
  a.segment_is_null[1] = 0;
  a.segment_limits[1] = -1;
  a.segment_offsets[1] = 0;
  a.is_32 || a.update_cs_size(!0);
  a.cpl = 3;
  a.cpl_changed();
  a.sreg[2] = c + 24 | 3;
  a.segment_is_null[2] = 0;
  a.segment_limits[2] = -1;
  a.segment_offsets[2] = 0;
  a.stack_size_32 = !0;
  a.stack_reg = a.reg32s;
  a.reg_vsp = 4;
  a.reg_vbp = 5;
};
table0F_16[54] = table0F_32[54] = function(a) {
  a.trigger_ud();
};
table0F_16[55] = table0F_32[55] = function(a) {
  a.trigger_ud();
};
table0F_16[56] = table0F_32[56] = function(a) {
  a.trigger_ud();
};
table0F_16[57] = table0F_32[57] = function(a) {
  a.trigger_ud();
};
table0F_16[58] = table0F_32[58] = function(a) {
  a.trigger_ud();
};
table0F_16[59] = table0F_32[59] = function(a) {
  a.trigger_ud();
};
table0F_16[60] = table0F_32[60] = function(a) {
  a.trigger_ud();
};
table0F_16[61] = table0F_32[61] = function(a) {
  a.trigger_ud();
};
table0F_16[62] = table0F_32[62] = function(a) {
  a.trigger_ud();
};
table0F_16[63] = table0F_32[63] = function(a) {
  a.trigger_ud();
};
table0F_16[64] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_o() && (a.reg16[c >> 2 & 14] = d);
};
table0F_32[64] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_o() && (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[65] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_o() || (a.reg16[c >> 2 & 14] = d);
};
table0F_32[65] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_o() || (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[66] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_b() && (a.reg16[c >> 2 & 14] = d);
};
table0F_32[66] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_b() && (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[67] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_b() || (a.reg16[c >> 2 & 14] = d);
};
table0F_32[67] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_b() || (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[68] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_z() && (a.reg16[c >> 2 & 14] = d);
};
table0F_32[68] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_z() && (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[69] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_z() || (a.reg16[c >> 2 & 14] = d);
};
table0F_32[69] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_z() || (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[70] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_be() && (a.reg16[c >> 2 & 14] = d);
};
table0F_32[70] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_be() && (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[71] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_be() || (a.reg16[c >> 2 & 14] = d);
};
table0F_32[71] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_be() || (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[72] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_s() && (a.reg16[c >> 2 & 14] = d);
};
table0F_32[72] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_s() && (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[73] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_s() || (a.reg16[c >> 2 & 14] = d);
};
table0F_32[73] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_s() || (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[74] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_p() && (a.reg16[c >> 2 & 14] = d);
};
table0F_32[74] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_p() && (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[75] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_p() || (a.reg16[c >> 2 & 14] = d);
};
table0F_32[75] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_p() || (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[76] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_l() && (a.reg16[c >> 2 & 14] = d);
};
table0F_32[76] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_l() && (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[77] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_l() || (a.reg16[c >> 2 & 14] = d);
};
table0F_32[77] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_l() || (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[78] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_le() && (a.reg16[c >> 2 & 14] = d);
};
table0F_32[78] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_le() && (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[79] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.test_le() || (a.reg16[c >> 2 & 14] = d);
};
table0F_32[79] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.test_le() || (a.reg32s[c >> 3 & 7] = d);
};
table0F_16[80] = table0F_32[80] = function(a) {
  a.trigger_ud();
};
table0F_16[81] = table0F_32[81] = function(a) {
  a.trigger_ud();
};
table0F_16[82] = table0F_32[82] = function(a) {
  a.trigger_ud();
};
table0F_16[83] = table0F_32[83] = function(a) {
  a.trigger_ud();
};
table0F_16[84] = table0F_32[84] = function(a) {
  a.trigger_ud();
};
table0F_16[85] = table0F_32[85] = function(a) {
  a.trigger_ud();
};
table0F_16[86] = table0F_32[86] = function(a) {
  a.trigger_ud();
};
table0F_16[87] = table0F_32[87] = function(a) {
  a.trigger_ud();
};
table0F_16[88] = table0F_32[88] = function(a) {
  a.trigger_ud();
};
table0F_16[89] = table0F_32[89] = function(a) {
  a.trigger_ud();
};
table0F_16[90] = table0F_32[90] = function(a) {
  a.trigger_ud();
};
table0F_16[91] = table0F_32[91] = function(a) {
  a.trigger_ud();
};
table0F_16[92] = table0F_32[92] = function(a) {
  a.trigger_ud();
};
table0F_16[93] = table0F_32[93] = function(a) {
  a.trigger_ud();
};
table0F_16[94] = table0F_32[94] = function(a) {
  a.trigger_ud();
};
table0F_16[95] = table0F_32[95] = function(a) {
  a.trigger_ud();
};
table0F_16[96] = table0F_32[96] = function(a) {
  a.trigger_ud();
};
table0F_16[97] = table0F_32[97] = function(a) {
  a.trigger_ud();
};
table0F_16[98] = table0F_32[98] = function(a) {
  a.trigger_ud();
};
table0F_16[99] = table0F_32[99] = function(a) {
  a.trigger_ud();
};
table0F_16[100] = table0F_32[100] = function(a) {
  a.trigger_ud();
};
table0F_16[101] = table0F_32[101] = function(a) {
  a.trigger_ud();
};
table0F_16[102] = table0F_32[102] = function(a) {
  a.trigger_ud();
};
table0F_16[103] = table0F_32[103] = function(a) {
  a.trigger_ud();
};
table0F_16[104] = table0F_32[104] = function(a) {
  a.trigger_ud();
};
table0F_16[105] = table0F_32[105] = function(a) {
  a.trigger_ud();
};
table0F_16[106] = table0F_32[106] = function(a) {
  a.trigger_ud();
};
table0F_16[107] = table0F_32[107] = function(a) {
  a.trigger_ud();
};
table0F_16[108] = table0F_32[108] = function(a) {
  a.trigger_ud();
};
table0F_16[109] = table0F_32[109] = function(a) {
  a.trigger_ud();
};
table0F_16[110] = table0F_32[110] = function(a) {
  a.trigger_ud();
};
table0F_16[111] = table0F_32[111] = function(a) {
  a.trigger_ud();
};
table0F_16[112] = table0F_32[112] = function(a) {
  a.trigger_ud();
};
table0F_16[113] = table0F_32[113] = function(a) {
  a.trigger_ud();
};
table0F_16[114] = table0F_32[114] = function(a) {
  a.trigger_ud();
};
table0F_16[115] = table0F_32[115] = function(a) {
  a.trigger_ud();
};
table0F_16[116] = table0F_32[116] = function(a) {
  a.trigger_ud();
};
table0F_16[117] = table0F_32[117] = function(a) {
  a.trigger_ud();
};
table0F_16[118] = table0F_32[118] = function(a) {
  a.trigger_ud();
};
table0F_16[119] = table0F_32[119] = function(a) {
  a.trigger_ud();
};
table0F_16[120] = table0F_32[120] = function(a) {
  a.trigger_ud();
};
table0F_16[121] = table0F_32[121] = function(a) {
  a.trigger_ud();
};
table0F_16[122] = table0F_32[122] = function(a) {
  a.trigger_ud();
};
table0F_16[123] = table0F_32[123] = function(a) {
  a.trigger_ud();
};
table0F_16[124] = table0F_32[124] = function(a) {
  a.trigger_ud();
};
table0F_16[125] = table0F_32[125] = function(a) {
  a.trigger_ud();
};
table0F_16[126] = table0F_32[126] = function(a) {
  a.trigger_ud();
};
table0F_16[127] = table0F_32[127] = function(a) {
  a.trigger_ud();
};
table0F_16[128] = function(a) {
  a.jmpcc16(a.test_o());
};
table0F_32[128] = function(a) {
  a.jmpcc32(a.test_o());
};
table0F_16[129] = function(a) {
  a.jmpcc16(!a.test_o());
};
table0F_32[129] = function(a) {
  a.jmpcc32(!a.test_o());
};
table0F_16[130] = function(a) {
  a.jmpcc16(a.test_b());
};
table0F_32[130] = function(a) {
  a.jmpcc32(a.test_b());
};
table0F_16[131] = function(a) {
  a.jmpcc16(!a.test_b());
};
table0F_32[131] = function(a) {
  a.jmpcc32(!a.test_b());
};
table0F_16[132] = function(a) {
  a.jmpcc16(a.test_z());
};
table0F_32[132] = function(a) {
  a.jmpcc32(a.test_z());
};
table0F_16[133] = function(a) {
  a.jmpcc16(!a.test_z());
};
table0F_32[133] = function(a) {
  a.jmpcc32(!a.test_z());
};
table0F_16[134] = function(a) {
  a.jmpcc16(a.test_be());
};
table0F_32[134] = function(a) {
  a.jmpcc32(a.test_be());
};
table0F_16[135] = function(a) {
  a.jmpcc16(!a.test_be());
};
table0F_32[135] = function(a) {
  a.jmpcc32(!a.test_be());
};
table0F_16[136] = function(a) {
  a.jmpcc16(a.test_s());
};
table0F_32[136] = function(a) {
  a.jmpcc32(a.test_s());
};
table0F_16[137] = function(a) {
  a.jmpcc16(!a.test_s());
};
table0F_32[137] = function(a) {
  a.jmpcc32(!a.test_s());
};
table0F_16[138] = function(a) {
  a.jmpcc16(a.test_p());
};
table0F_32[138] = function(a) {
  a.jmpcc32(a.test_p());
};
table0F_16[139] = function(a) {
  a.jmpcc16(!a.test_p());
};
table0F_32[139] = function(a) {
  a.jmpcc32(!a.test_p());
};
table0F_16[140] = function(a) {
  a.jmpcc16(a.test_l());
};
table0F_32[140] = function(a) {
  a.jmpcc32(a.test_l());
};
table0F_16[141] = function(a) {
  a.jmpcc16(!a.test_l());
};
table0F_32[141] = function(a) {
  a.jmpcc32(!a.test_l());
};
table0F_16[142] = function(a) {
  a.jmpcc16(a.test_le());
};
table0F_32[142] = function(a) {
  a.jmpcc32(a.test_le());
};
table0F_16[143] = function(a) {
  a.jmpcc16(!a.test_le());
};
table0F_32[143] = function(a) {
  a.jmpcc32(!a.test_le());
};
table0F_16[144] = table0F_32[144] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !a.test_o() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[145] = table0F_32[145] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !!a.test_o() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[146] = table0F_32[146] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !a.test_b() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[147] = table0F_32[147] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !!a.test_b() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[148] = table0F_32[148] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !a.test_z() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[149] = table0F_32[149] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !!a.test_z() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[150] = table0F_32[150] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !a.test_be() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[151] = table0F_32[151] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !!a.test_be() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[152] = table0F_32[152] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !a.test_s() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[153] = table0F_32[153] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !!a.test_s() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[154] = table0F_32[154] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !a.test_p() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[155] = table0F_32[155] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !!a.test_p() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[156] = table0F_32[156] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !a.test_l() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[157] = table0F_32[157] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !!a.test_l() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[158] = table0F_32[158] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !a.test_le() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[159] = table0F_32[159] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c)
  }
  var e = !!a.test_le() ^ 1;
  192 > c ? a.safe_write8(d, e) : a.reg8[c << 2 & 12 | c >> 2 & 1] = e;
};
table0F_16[160] = function(a) {
  a.push16(a.sreg[4]);
};
table0F_32[160] = function(a) {
  a.push32(a.sreg[4]);
};
table0F_16[161] = function(a) {
  a.switch_seg(4, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 2;
};
table0F_32[161] = function(a) {
  a.switch_seg(4, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 4;
};
table0F_16[162] = table0F_32[162] = function(a) {
  a.cpuid();
};
table0F_16[163] = function(a) {
  var c = a.read_imm8();
  192 > c ? a.bt_mem(a.modrm_resolve(c), a.reg16s[c >> 2 & 14]) : a.bt_reg(a.reg16[c << 1 & 14], a.reg16[c >> 2 & 14] & 15);
};
table0F_32[163] = function(a) {
  var c = a.read_imm8();
  192 > c ? a.bt_mem(a.modrm_resolve(c), a.reg32s[c >> 3 & 7]) : a.bt_reg(a.reg32s[c & 7], a.reg32s[c >> 3 & 7] & 31);
};
table0F_16[164] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.shld16(d, a.reg16[c >> 2 & 14], a.read_imm8() & 31);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table0F_32[164] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.shld32(d, a.reg32s[c >> 3 & 7], a.read_imm8() & 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table0F_16[165] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.shld16(d, a.reg16[c >> 2 & 14], a.reg8[4] & 31);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table0F_32[165] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.shld32(d, a.reg32s[c >> 3 & 7], a.reg8[4] & 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table0F_16[166] = table0F_32[166] = function(a) {
  a.trigger_ud();
};
table0F_16[167] = table0F_32[167] = function(a) {
  a.trigger_ud();
};
table0F_16[168] = function(a) {
  a.push16(a.sreg[5]);
};
table0F_32[168] = function(a) {
  a.push32(a.sreg[5]);
};
table0F_16[169] = function(a) {
  a.switch_seg(5, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 2;
};
table0F_32[169] = function(a) {
  a.switch_seg(5, a.safe_read16(a.get_stack_pointer(0)));
  a.stack_reg[a.reg_vsp] += 4;
};
table0F_16[170] = table0F_32[170] = function(a) {
  a.trigger_ud();
};
table0F_16[171] = function(a) {
  var c = a.read_imm8();
  192 > c ? a.bts_mem(a.modrm_resolve(c), a.reg16s[c >> 2 & 14]) : a.reg16[c << 1 & 14] = a.bts_reg(a.reg16[c << 1 & 14], a.reg16s[c >> 2 & 14] & 15);
};
table0F_32[171] = function(a) {
  var c = a.read_imm8();
  192 > c ? a.bts_mem(a.modrm_resolve(c), a.reg32s[c >> 3 & 7]) : a.reg32s[c & 7] = a.bts_reg(a.reg32s[c & 7], a.reg32s[c >> 3 & 7] & 31);
};
table0F_16[172] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.shrd16(d, a.reg16[c >> 2 & 14], a.read_imm8() & 31);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table0F_32[172] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.shrd32(d, a.reg32s[c >> 3 & 7], a.read_imm8() & 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table0F_16[173] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.shrd16(d, a.reg16[c >> 2 & 14], a.reg8[4] & 31);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table0F_32[173] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.shrd32(d, a.reg32s[c >> 3 & 7], a.reg8[4] & 31);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table0F_16[174] = table0F_32[174] = function(a) {
  switch(a.read_imm8() >> 3 & 7) {
    case 6:
      break;
    default:
      a.trigger_ud();
  }
};
table0F_16[175] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) << 16 >> 16 : a.reg16s[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.imul_reg16(a.reg16s[c >> 2 & 14], d);
};
table0F_32[175] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.imul_reg32(a.reg32s[c >> 3 & 7], d);
};
table0F_16[176] = table0F_32[176] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c);
    a.writable_or_pagefault(d, 1);
    var e = a.safe_read8(d);
  } else {
    e = a.reg8[c << 2 & 12 | c >> 2 & 1];
  }
  a.sub(e, a.reg8[0], 7);
  a.getzf() ? 192 > c ? a.safe_write8(d, a.reg8[c >> 1 & 12 | c >> 5 & 1]) : a.reg8[c << 2 & 12 | c >> 2 & 1] = a.reg8[c >> 1 & 12 | c >> 5 & 1] : a.reg8[0] = e;
};
table0F_16[177] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c);
    a.writable_or_pagefault(d, 2);
    var e = a.safe_read16(d);
  } else {
    e = a.reg16[c << 1 & 14];
  }
  a.sub(e, a.reg16[0], 15);
  a.getzf() ? 192 > c ? a.safe_write16(d, a.reg16[c >> 2 & 14]) : a.reg16[c << 1 & 14] = a.reg16[c >> 2 & 14] : a.reg16[0] = e;
};
table0F_32[177] = function(a) {
  var c = a.read_imm8();
  if (192 > c) {
    var d = a.modrm_resolve(c);
    a.writable_or_pagefault(d, 4);
    var e = a.safe_read32s(d);
  } else {
    e = a.reg32s[c & 7];
  }
  a.sub(e, a.reg32s[0], 31);
  a.getzf() ? 192 > c ? a.safe_write32(d, a.reg32s[c >> 3 & 7]) : a.reg32s[c & 7] = a.reg32s[c >> 3 & 7] : a.reg32s[0] = e;
};
table0F_16[178] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss16(2, a.modrm_resolve(c), c >> 2 & 14);
};
table0F_32[178] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss32(2, a.modrm_resolve(c), c >> 3 & 7);
};
table0F_16[179] = function(a) {
  var c = a.read_imm8();
  192 > c ? a.btr_mem(a.modrm_resolve(c), a.reg16s[c >> 2 & 14]) : a.reg16[c << 1 & 14] = a.btr_reg(a.reg16[c << 1 & 14], a.reg16s[c >> 2 & 14] & 15);
};
table0F_32[179] = function(a) {
  var c = a.read_imm8();
  192 > c ? a.btr_mem(a.modrm_resolve(c), a.reg32s[c >> 3 & 7]) : a.reg32s[c & 7] = a.btr_reg(a.reg32s[c & 7], a.reg32s[c >> 3 & 7] & 31);
};
table0F_16[180] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss16(4, a.modrm_resolve(c), c >> 2 & 14);
};
table0F_32[180] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss32(4, a.modrm_resolve(c), c >> 3 & 7);
};
table0F_16[181] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss16(5, a.modrm_resolve(c), c >> 2 & 14);
};
table0F_32[181] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  a.lss32(5, a.modrm_resolve(c), c >> 3 & 7);
};
table0F_16[182] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg16[c >> 2 & 14] = d;
};
table0F_32[182] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) : a.reg8[c << 2 & 12 | c >> 2 & 1];
  a.reg32s[c >> 3 & 7] = d;
};
table0F_16[183] = table0F_32[183] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg32s[c >> 3 & 7] = d;
};
table0F_16[184] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.popcnt(d);
};
table0F_32[184] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.popcnt(d);
};
table0F_16[185] = table0F_32[185] = function(a) {
  a.trigger_ud();
};
table0F_16[186] = function(a) {
  var c = a.read_imm8();
  switch(c >> 3 & 7) {
    case 4:
      192 > c ? a.bt_mem(a.modrm_resolve(c), a.read_imm8() & 15) : a.bt_reg(a.reg16[c << 1 & 14], a.read_imm8() & 15);
      break;
    case 5:
      192 > c ? a.bts_mem(a.modrm_resolve(c), a.read_imm8()) : a.reg16[c << 1 & 14] = a.bts_reg(a.reg16[c << 1 & 14], a.read_imm8() & 15);
      break;
    case 6:
      192 > c ? a.btr_mem(a.modrm_resolve(c), a.read_imm8()) : a.reg16[c << 1 & 14] = a.btr_reg(a.reg16[c << 1 & 14], a.read_imm8() & 15);
      break;
    case 7:
      192 > c ? a.btc_mem(a.modrm_resolve(c), a.read_imm8()) : a.reg16[c << 1 & 14] = a.btc_reg(a.reg16[c << 1 & 14], a.read_imm8() & 15);
      break;
    default:
      a.trigger_ud();
  }
};
table0F_32[186] = function(a) {
  var c = a.read_imm8();
  switch(c >> 3 & 7) {
    case 4:
      192 > c ? a.bt_mem(a.modrm_resolve(c), a.read_imm8() & 31) : a.bt_reg(a.reg32s[c & 7], a.read_imm8() & 31);
      break;
    case 5:
      192 > c ? a.bts_mem(a.modrm_resolve(c), a.read_imm8()) : a.reg32s[c & 7] = a.bts_reg(a.reg32s[c & 7], a.read_imm8() & 31);
      break;
    case 6:
      192 > c ? a.btr_mem(a.modrm_resolve(c), a.read_imm8()) : a.reg32s[c & 7] = a.btr_reg(a.reg32s[c & 7], a.read_imm8() & 31);
      break;
    case 7:
      192 > c ? a.btc_mem(a.modrm_resolve(c), a.read_imm8()) : a.reg32s[c & 7] = a.btc_reg(a.reg32s[c & 7], a.read_imm8() & 31);
      break;
    default:
      a.trigger_ud();
  }
};
table0F_16[187] = function(a) {
  var c = a.read_imm8();
  192 > c ? a.btc_mem(a.modrm_resolve(c), a.reg16s[c >> 2 & 14]) : a.reg16[c << 1 & 14] = a.btc_reg(a.reg16[c << 1 & 14], a.reg16s[c >> 2 & 14] & 15);
};
table0F_32[187] = function(a) {
  var c = a.read_imm8();
  192 > c ? a.btc_mem(a.modrm_resolve(c), a.reg32s[c >> 3 & 7]) : a.reg32s[c & 7] = a.btc_reg(a.reg32s[c & 7], a.reg32s[c >> 3 & 7] & 31);
};
table0F_16[188] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.bsf16(a.reg16[c >> 2 & 14], d);
};
table0F_32[188] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.bsf32(a.reg32s[c >> 3 & 7], d);
};
table0F_16[189] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) : a.reg16[c << 1 & 14];
  a.reg16[c >> 2 & 14] = a.bsr16(a.reg16[c >> 2 & 14], d);
};
table0F_32[189] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read32s(a.modrm_resolve(c)) : a.reg32s[c & 7];
  a.reg32s[c >> 3 & 7] = a.bsr32(a.reg32s[c >> 3 & 7], d);
};
table0F_16[190] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) << 24 >> 24 : a.reg8s[c << 2 & 12 | c >> 2 & 1];
  a.reg16[c >> 2 & 14] = d;
};
table0F_32[190] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read8(a.modrm_resolve(c)) << 24 >> 24 : a.reg8s[c << 2 & 12 | c >> 2 & 1];
  a.reg32s[c >> 3 & 7] = d;
};
table0F_16[191] = table0F_32[191] = function(a) {
  var c = a.read_imm8(), d = 192 > c ? a.safe_read16(a.modrm_resolve(c)) << 16 >> 16 : a.reg16s[c << 1 & 14];
  a.reg32s[c >> 3 & 7] = d;
};
table0F_16[192] = table0F_32[192] = function(a) {
  var c = a.read_imm8(), d, e;
  192 > c ? (e = a.translate_address_write(a.modrm_resolve(c)), d = a.memory.read8(e)) : d = a.reg8[c << 2 & 12 | c >> 2 & 1];
  d = a.xadd8(d, c >> 1 & 12 | c >> 5 & 1);
  192 > c ? a.memory.write8(e, d) : a.reg8[c << 2 & 12 | c >> 2 & 1] = d;
};
table0F_16[193] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4095 === (d & 4095) ? (f = a.translate_address_write(d + 1), d = a.virt_boundary_read16(e, f)) : d = a.memory.read16(e)) : d = a.reg16[c << 1 & 14];
  d = a.xadd16(d, c >> 2 & 14);
  192 > c ? f ? a.virt_boundary_write16(e, f, d) : a.memory.write16(e, d) : a.reg16[c << 1 & 14] = d;
};
table0F_32[193] = function(a) {
  var c = a.read_imm8(), d, e, f = 0;
  192 > c ? (d = a.modrm_resolve(c), e = a.translate_address_write(d), a.paging && 4093 <= (d & 4095) ? (f = a.translate_address_write(d + 3), d = a.virt_boundary_read32s(e, f)) : d = a.memory.read32s(e)) : d = a.reg32s[c & 7];
  d = a.xadd32(d, c >> 3 & 7);
  192 > c ? f ? a.virt_boundary_write32(e, f, d) : a.memory.write32(e, d) : a.reg32s[c & 7] = d;
};
table0F_16[194] = table0F_32[194] = function(a) {
  a.trigger_ud();
};
table0F_16[195] = table0F_32[195] = function(a) {
  a.trigger_ud();
};
table0F_16[196] = table0F_32[196] = function(a) {
  a.trigger_ud();
};
table0F_16[197] = table0F_32[197] = function(a) {
  a.trigger_ud();
};
table0F_16[198] = table0F_32[198] = function(a) {
  a.trigger_ud();
};
table0F_16[199] = table0F_32[199] = function(a) {
  var c = a.read_imm8();
  192 <= c && a.trigger_ud();
  c = a.modrm_resolve(c);
  a.writable_or_pagefault(c, 8);
  var d = a.safe_read32s(c), e = a.safe_read32s(c + 4);
  a.reg32s[0] === d && a.reg32s[2] === e ? (a.flags |= 64, a.safe_write32(c, a.reg32s[3]), a.safe_write32(c + 4, a.reg32s[1])) : (a.flags &= -65, a.reg32s[0] = d, a.reg32s[2] = e);
  a.flags_changed &= -65;
};
table0F_16[200] = table0F_32[200] = function(a) {
  a.bswap(0);
};
table0F_16[201] = table0F_32[201] = function(a) {
  a.bswap(1);
};
table0F_16[202] = table0F_32[202] = function(a) {
  a.bswap(2);
};
table0F_16[203] = table0F_32[203] = function(a) {
  a.bswap(3);
};
table0F_16[204] = table0F_32[204] = function(a) {
  a.bswap(4);
};
table0F_16[205] = table0F_32[205] = function(a) {
  a.bswap(5);
};
table0F_16[206] = table0F_32[206] = function(a) {
  a.bswap(6);
};
table0F_16[207] = table0F_32[207] = function(a) {
  a.bswap(7);
};
table0F_16[208] = table0F_32[208] = function(a) {
  a.trigger_ud();
};
table0F_16[209] = table0F_32[209] = function(a) {
  a.trigger_ud();
};
table0F_16[210] = table0F_32[210] = function(a) {
  a.trigger_ud();
};
table0F_16[211] = table0F_32[211] = function(a) {
  a.trigger_ud();
};
table0F_16[212] = table0F_32[212] = function(a) {
  a.trigger_ud();
};
table0F_16[213] = table0F_32[213] = function(a) {
  a.trigger_ud();
};
table0F_16[214] = table0F_32[214] = function(a) {
  a.trigger_ud();
};
table0F_16[215] = table0F_32[215] = function(a) {
  a.trigger_ud();
};
table0F_16[216] = table0F_32[216] = function(a) {
  a.trigger_ud();
};
table0F_16[217] = table0F_32[217] = function(a) {
  a.trigger_ud();
};
table0F_16[218] = table0F_32[218] = function(a) {
  a.trigger_ud();
};
table0F_16[219] = table0F_32[219] = function(a) {
  a.trigger_ud();
};
table0F_16[220] = table0F_32[220] = function(a) {
  a.trigger_ud();
};
table0F_16[221] = table0F_32[221] = function(a) {
  a.trigger_ud();
};
table0F_16[222] = table0F_32[222] = function(a) {
  a.trigger_ud();
};
table0F_16[223] = table0F_32[223] = function(a) {
  a.trigger_ud();
};
table0F_16[224] = table0F_32[224] = function(a) {
  a.trigger_ud();
};
table0F_16[225] = table0F_32[225] = function(a) {
  a.trigger_ud();
};
table0F_16[226] = table0F_32[226] = function(a) {
  a.trigger_ud();
};
table0F_16[227] = table0F_32[227] = function(a) {
  a.trigger_ud();
};
table0F_16[228] = table0F_32[228] = function(a) {
  a.trigger_ud();
};
table0F_16[229] = table0F_32[229] = function(a) {
  a.trigger_ud();
};
table0F_16[230] = table0F_32[230] = function(a) {
  a.trigger_ud();
};
table0F_16[231] = table0F_32[231] = function(a) {
  a.trigger_ud();
};
table0F_16[232] = table0F_32[232] = function(a) {
  a.trigger_ud();
};
table0F_16[233] = table0F_32[233] = function(a) {
  a.trigger_ud();
};
table0F_16[234] = table0F_32[234] = function(a) {
  a.trigger_ud();
};
table0F_16[235] = table0F_32[235] = function(a) {
  a.trigger_ud();
};
table0F_16[236] = table0F_32[236] = function(a) {
  a.trigger_ud();
};
table0F_16[237] = table0F_32[237] = function(a) {
  a.trigger_ud();
};
table0F_16[238] = table0F_32[238] = function(a) {
  a.trigger_ud();
};
table0F_16[239] = table0F_32[239] = function(a) {
  a.trigger_ud();
};
table0F_16[240] = table0F_32[240] = function(a) {
  a.trigger_ud();
};
table0F_16[241] = table0F_32[241] = function(a) {
  a.trigger_ud();
};
table0F_16[242] = table0F_32[242] = function(a) {
  a.trigger_ud();
};
table0F_16[243] = table0F_32[243] = function(a) {
  a.trigger_ud();
};
table0F_16[244] = table0F_32[244] = function(a) {
  a.trigger_ud();
};
table0F_16[245] = table0F_32[245] = function(a) {
  a.trigger_ud();
};
table0F_16[246] = table0F_32[246] = function(a) {
  a.trigger_ud();
};
table0F_16[247] = table0F_32[247] = function(a) {
  a.trigger_ud();
};
table0F_16[248] = table0F_32[248] = function(a) {
  a.trigger_ud();
};
table0F_16[249] = table0F_32[249] = function(a) {
  a.trigger_ud();
};
table0F_16[250] = table0F_32[250] = function(a) {
  a.trigger_ud();
};
table0F_16[251] = table0F_32[251] = function(a) {
  a.trigger_ud();
};
table0F_16[252] = table0F_32[252] = function(a) {
  a.trigger_ud();
};
table0F_16[253] = table0F_32[253] = function(a) {
  a.trigger_ud();
};
table0F_16[254] = table0F_32[254] = function(a) {
  a.trigger_ud();
};
table0F_16[255] = table0F_32[255] = function(a) {
  a.trigger_ud();
};
"use strict";
CPU.prototype.jmp_rel16 = function(a) {
  var c = this.get_seg(1);
  this.instruction_pointer -= c;
  this.instruction_pointer = this.instruction_pointer + a & 65535;
  this.instruction_pointer = this.instruction_pointer + c | 0;
  this.last_instr_jump = !0;
};
CPU.prototype.jmpcc16 = function(a) {
  a ? this.jmp_rel16(this.read_imm16()) : this.instruction_pointer = this.instruction_pointer + 2 | 0;
  this.last_instr_jump = !0;
};
CPU.prototype.jmpcc32 = function(a) {
  a ? (a = this.read_imm32s(), this.instruction_pointer = this.instruction_pointer + a | 0) : this.instruction_pointer = this.instruction_pointer + 4 | 0;
  this.last_instr_jump = !0;
};
CPU.prototype.loopne = function() {
  if (--this.regv[this.reg_vcx] && !this.getzf()) {
    var a = this.read_imm8s();
    this.instruction_pointer = this.instruction_pointer + a | 0;
  } else {
    this.instruction_pointer++;
  }
  this.last_instr_jump = !0;
};
CPU.prototype.loope = function() {
  if (--this.regv[this.reg_vcx] && this.getzf()) {
    var a = this.read_imm8s();
    this.instruction_pointer = this.instruction_pointer + a | 0;
  } else {
    this.instruction_pointer++;
  }
  this.last_instr_jump = !0;
};
CPU.prototype.loop = function() {
  if (--this.regv[this.reg_vcx]) {
    var a = this.read_imm8s();
    this.instruction_pointer = this.instruction_pointer + a | 0;
  } else {
    this.instruction_pointer++;
  }
  this.last_instr_jump = !0;
};
CPU.prototype.jcxz = function() {
  var a = this.read_imm8s();
  0 === this.regv[this.reg_vcx] && (this.instruction_pointer = this.instruction_pointer + a | 0);
  this.last_instr_jump = !0;
};
CPU.prototype.getcf = function() {
  return this.flags_changed & 1 ? (this.last_op1 ^ (this.last_op1 ^ this.last_op2) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1 : this.flags & 1;
};
CPU.prototype.getpf = function() {
  return this.flags_changed & 4 ? 154020 >> ((this.last_result ^ this.last_result >> 4) & 15) & 4 : this.flags & 4;
};
CPU.prototype.getaf = function() {
  return this.flags_changed & 16 ? (this.last_op1 ^ this.last_op2 ^ this.last_add_result) & 16 : this.flags & 16;
};
CPU.prototype.getzf = function() {
  return this.flags_changed & 64 ? (~this.last_result & this.last_result - 1) >>> this.last_op_size & 1 : this.flags & 64;
};
CPU.prototype.getsf = function() {
  return this.flags_changed & 128 ? this.last_result >>> this.last_op_size & 1 : this.flags & 128;
};
CPU.prototype.getof = function() {
  return this.flags_changed & 2048 ? ((this.last_op1 ^ this.last_add_result) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1 : this.flags & 2048;
};
CPU.prototype.test_o = CPU.prototype.getof;
CPU.prototype.test_b = CPU.prototype.getcf;
CPU.prototype.test_z = CPU.prototype.getzf;
CPU.prototype.test_s = CPU.prototype.getsf;
CPU.prototype.test_p = CPU.prototype.getpf;
CPU.prototype.test_be = function() {
  return this.getcf() || this.getzf();
};
CPU.prototype.test_l = function() {
  return!this.getsf() !== !this.getof();
};
CPU.prototype.test_le = function() {
  return this.getzf() || !this.getsf() !== !this.getof();
};
CPU.prototype.push16 = function(a) {
  var c = this.get_stack_pointer(-2);
  this.safe_write16(c, a);
  this.stack_reg[this.reg_vsp] -= 2;
};
CPU.prototype.push32 = function(a) {
  var c = this.get_stack_pointer(-4);
  this.safe_write32(c, a);
  this.stack_reg[this.reg_vsp] -= 4;
};
CPU.prototype.pop16 = function() {
  var a = this.get_seg(2) + this.stack_reg[this.reg_vsp] | 0, a = this.safe_read16(a);
  this.stack_reg[this.reg_vsp] += 2;
  return a;
};
CPU.prototype.pop32s = function() {
  var a = this.get_seg(2) + this.stack_reg[this.reg_vsp] | 0, a = this.safe_read32s(a);
  this.stack_reg[this.reg_vsp] += 4;
  return a;
};
CPU.prototype.pusha16 = function() {
  var a = this.reg16[8];
  this.translate_address_write(this.get_seg(2) + a - 15 | 0);
  this.push16(this.reg16[0]);
  this.push16(this.reg16[2]);
  this.push16(this.reg16[4]);
  this.push16(this.reg16[6]);
  this.push16(a);
  this.push16(this.reg16[10]);
  this.push16(this.reg16[12]);
  this.push16(this.reg16[14]);
};
CPU.prototype.pusha32 = function() {
  var a = this.reg32s[4];
  this.translate_address_write(this.get_seg(2) + a - 31 | 0);
  this.push32(this.reg32s[0]);
  this.push32(this.reg32s[1]);
  this.push32(this.reg32s[2]);
  this.push32(this.reg32s[3]);
  this.push32(a);
  this.push32(this.reg32s[5]);
  this.push32(this.reg32s[6]);
  this.push32(this.reg32s[7]);
};
CPU.prototype.popa16 = function() {
  this.translate_address_read(this.get_seg(2) + this.stack_reg[this.reg_vsp] + 15 | 0);
  this.reg16[14] = this.pop16();
  this.reg16[12] = this.pop16();
  this.reg16[10] = this.pop16();
  this.stack_reg[this.reg_vsp] += 2;
  this.reg16[6] = this.pop16();
  this.reg16[4] = this.pop16();
  this.reg16[2] = this.pop16();
  this.reg16[0] = this.pop16();
};
CPU.prototype.popa32 = function() {
  this.translate_address_read(this.get_seg(2) + this.stack_reg[this.reg_vsp] + 31 | 0);
  this.reg32s[7] = this.pop32s();
  this.reg32s[6] = this.pop32s();
  this.reg32s[5] = this.pop32s();
  this.stack_reg[this.reg_vsp] += 4;
  this.reg32s[3] = this.pop32s();
  this.reg32s[2] = this.pop32s();
  this.reg32s[1] = this.pop32s();
  this.reg32s[0] = this.pop32s();
};
CPU.prototype.xchg8 = function(a, c) {
  var d = c >> 1 & 12 | c >> 5 & 1, e = this.reg8[d];
  this.reg8[d] = a;
  return e;
};
CPU.prototype.xchg16 = function(a, c) {
  var d = c >> 2 & 14, e = this.reg16[d];
  this.reg16[d] = a;
  return e;
};
CPU.prototype.xchg16r = function(a) {
  var c = this.reg16[0];
  this.reg16[0] = this.reg16[a];
  this.reg16[a] = c;
};
CPU.prototype.xchg32 = function(a, c) {
  var d = c >> 3 & 7, e = this.reg32s[d];
  this.reg32s[d] = a;
  return e;
};
CPU.prototype.xchg32r = function(a) {
  var c = this.reg32s[0];
  this.reg32s[0] = this.reg32s[a];
  this.reg32s[a] = c;
};
CPU.prototype.lss16 = function(a, c, d) {
  var e = this.safe_read16(c);
  c = this.safe_read16(c + 2 | 0);
  this.switch_seg(a, c);
  this.reg16[d] = e;
};
CPU.prototype.lss32 = function(a, c, d) {
  var e = this.safe_read32s(c);
  c = this.safe_read16(c + 4 | 0);
  this.switch_seg(a, c);
  this.reg32s[d] = e;
};
CPU.prototype.enter16 = function() {
  var a = this.read_imm16(), c = this.read_imm8() & 31, d, e;
  this.push16(this.reg16[10]);
  d = this.reg16[8];
  if (0 < c) {
    e = this.reg16[5];
    for (var f = 1;f < c;f++) {
      e -= 2, this.push16(this.safe_read16(this.get_seg(2) + e | 0));
    }
    this.push16(d);
  }
  this.reg16[10] = d;
  this.reg16[8] -= a;
};
CPU.prototype.enter32 = function() {
  var a = this.read_imm16(), c = this.read_imm8() & 31, d, e;
  this.push32(this.reg32s[5]);
  d = this.reg32s[4];
  if (0 < c) {
    e = this.reg32s[5];
    for (var f = 1;f < c;f++) {
      e -= 4, this.push32(this.safe_read32s(this.get_seg(2) + e | 0));
    }
    this.push32(d);
  }
  this.reg32s[5] = d;
  this.reg32s[4] -= a;
};
CPU.prototype.bswap = function(a) {
  var c = this.reg32s[a];
  this.reg32s[a] = c >>> 24 | c << 24 | c >> 8 & 65280 | c << 8 & 16711680;
};
CPU.prototype.main_run = function() {
  try {
    if (this.in_hlt) {
      return this.hlt_loop();
    }
    this.do_run();
  } catch (a) {
    this.exception_cleanup(a);
  }
  return 0;
};
CPU.prototype.exception_cleanup = function(a) {
  if (233495534 === a) {
    this.page_fault = !1, this.repeat_string_prefix = 0, this.segment_prefix = -1, this.address_size_32 = this.is_32, this.update_address_size(), this.operand_size_32 = this.is_32, this.update_operand_size();
  } else {
    throw console.log(a), console.log(a.stack), a;
  }
};
CPU.prototype.reboot_internal = function() {
  this.CPU_prototype$reset();
  this.load_bios();
  throw 233495534;
};
CPU.prototype.CPU_prototype$reset = function() {
  this.segment_is_null = new Uint8Array(8);
  this.segment_limits = new Uint32Array(8);
  this.segment_offsets = new Int32Array(8);
  this.full_clear_tlb();
  this.reg32s = new Int32Array(8);
  this.reg32 = new Uint32Array(this.reg32s.buffer);
  this.reg16s = new Int16Array(this.reg32s.buffer);
  this.reg16 = new Uint16Array(this.reg32s.buffer);
  this.reg8s = new Int8Array(this.reg32s.buffer);
  this.reg8 = new Uint8Array(this.reg32s.buffer);
  this.sreg = new Uint16Array(8);
  this.dreg = new Int32Array(8);
  this.protected_mode = !1;
  this.gdtr_offset = this.gdtr_size = this.idtr_offset = this.idtr_size = 0;
  this.page_fault = !1;
  this.cr0 = 1610612752;
  this.cr4 = this.cr3 = this.cr2 = 0;
  this.dreg[6] = -61456;
  this.dreg[7] = 1024;
  this.cpl = 0;
  this.paging = !1;
  this.page_size_extensions = 0;
  this.address_size_32 = this.stack_size_32 = this.operand_size_32 = this.is_32 = !1;
  this.paging_changed();
  this.update_operand_size();
  this.update_address_size();
  this.stack_reg = this.reg16;
  this.reg_vsp = 8;
  this.reg_vbp = 10;
  this.previous_ip = this.timestamp_counter = 0;
  this.in_hlt = !1;
  this.sysenter_eip = this.sysenter_esp = this.sysenter_cs = 0;
  this.segment_prefix = -1;
  this.repeat_string_prefix = 0;
  this.flags = 2;
  this.last_op_size = this.last_op2 = this.last_op1 = this.last_add_result = this.last_result = this.flags_changed = 0;
  this.tsc_offset = v86.microtick();
  this.instruction_pointer = 1048560;
  this.switch_seg(2, 48);
  this.reg16[8] = 256;
};
CPU.prototype.init = function(a, c) {
  this.memory_size = a.memory_size || 67108864;
  this.memory = new Memory(this.memory_size);
  this.CPU_prototype$reset();
  var d = new IO(this.memory);
  this.io = d;
  this.bios.main = a.bios;
  this.bios.vga = a.vga_bios;
  this.load_bios();
  var e = 0;
  d.register_read(146, this, function() {
    return e;
  });
  d.register_write(146, this, function(a) {
    e = a;
  });
  this.devices = {};
  a.load_devices && (this.devices.pic = new PIC(this), this.devices.pci = new PCI(this), this.devices.dma = new DMA(this), this.devices.acpi = new ACPI, this.devices.vga = new VGAScreen(this, c, a.vga_memory_size || 8388608), this.fpu = new FPU(this), this.devices.ps2 = new PS2(this, c), this.devices.uart = new UART(this, 1016, c), this.devices.fdc = new FloppyController(this, a.fda, a.fdb), a.cdrom && (this.devices.cdrom = new IDEDevice(this, a.cdrom, !0, 1)), a.hda && (this.devices.hda = new IDEDevice(this, 
  a.hda, !1, 0)), this.devices.pit = new PIT(this), this.devices.rtc = new RTC(this, this.devices.fdc.type, a.boot_order || 531), a.enable_ne2k && (this.devices.net = new Ne2k(this, c)), a.fs9p && (this.devices.virtio = new VirtIO(this, a.fs9p)));
};
CPU.prototype.load_bios = function() {
  var a = this.bios.main, c = this.bios.vga;
  if (a) {
    var d = new Uint8Array(a);
    this.memory.mem8.set(d, 1048576 - a.byteLength);
    c && (d = new Uint8Array(c), this.memory.mem8.set(d, 786432));
    this.io.mmap_register(4293918720, 1048576, function(a) {
      return this.memory.mem8[a & 1048575];
    }.bind(this), function(a, c) {
      this.memory.mem8[a & 1048575] = c;
    }.bind(this));
  }
};
CPU.prototype.do_run = function() {
  var a = Date.now(), c = a;
  for (this.devices.vga.timer();33 > c - a;) {
    this.devices.pit.timer(c, !1);
    this.devices.rtc.timer(c, !1);
    this.handle_irqs();
    for (c = 11001;c--;) {
      this.cycle();
    }
    c = Date.now();
  }
};
"undefined" !== typeof window && (window.__no_inline1 = CPU.prototype.do_run, window.__no_inline2 = CPU.prototype.exception_cleanup, window.__no_inline3 = CPU.prototype.hlt_loop);
CPU.prototype.cycle = function() {
  this.timestamp_counter++;
  this.previous_ip = this.instruction_pointer;
  var a = this.read_imm8();
  this.table[a](this);
};
CPU.prototype.do_op = function() {
  this.table[this.read_imm8()](this);
};
CPU.prototype.hlt_loop = function() {
  var a = Date.now();
  this.devices.pit.timer(a, !1);
  this.devices.rtc.timer(a, !1);
  this.devices.vga.timer(a);
  return 4;
};
CPU.prototype.cr0_changed = function() {
  var a = -2147483648 === (this.cr0 & -2147483648);
  this.fpu || (this.cr0 |= 4);
  this.cr0 |= 16;
  a !== this.paging && (this.paging = a, this.full_clear_tlb());
};
CPU.prototype.paging_changed = function() {
  this.last_virt_eip = -1;
};
CPU.prototype.cpl_changed = function() {
  this.last_virt_eip = -1;
};
CPU.prototype.read_imm8 = function() {
  this.instruction_pointer & -4096 ^ this.last_virt_eip && (this.eip_phys = this.translate_address_read(this.instruction_pointer) ^ this.instruction_pointer, this.last_virt_eip = this.instruction_pointer & -4096);
  var a = this.memory.mem8[this.eip_phys ^ this.instruction_pointer] | 0;
  this.instruction_pointer = this.instruction_pointer + 1 | 0;
  return a;
};
CPU.prototype.read_imm8s = function() {
  return this.read_imm8() << 24 >> 24;
};
CPU.prototype.read_imm16 = function() {
  if (4094 < (this.instruction_pointer ^ this.last_virt_eip) >>> 0) {
    return this.read_imm8() | this.read_imm8() << 8;
  }
  var a = this.memory.read16(this.eip_phys ^ this.instruction_pointer);
  this.instruction_pointer = this.instruction_pointer + 2 | 0;
  return a;
};
CPU.prototype.read_imm16s = function() {
  return this.read_imm16() << 16 >> 16;
};
CPU.prototype.read_imm32s = function() {
  if (4092 < (this.instruction_pointer ^ this.last_virt_eip) >>> 0) {
    return this.read_imm16() | this.read_imm16() << 16;
  }
  var a = this.memory.read32s(this.eip_phys ^ this.instruction_pointer);
  this.instruction_pointer = this.instruction_pointer + 4 | 0;
  return a;
};
CPU.prototype.virt_boundary_read16 = function(a, c) {
  return this.memory.read8(a) | this.memory.read8(c) << 8;
};
CPU.prototype.virt_boundary_read32s = function(a, c) {
  var d;
  d = a & 1 ? a & 2 ? this.memory.read_aligned16(c - 2 >> 1) : this.memory.read_aligned16(a + 1 >> 1) : this.virt_boundary_read16(a + 1, c - 1);
  return this.memory.read8(a) | d << 8 | this.memory.read8(c) << 24;
};
CPU.prototype.virt_boundary_write16 = function(a, c, d) {
  this.memory.write8(a, d);
  this.memory.write8(c, d >> 8);
};
CPU.prototype.virt_boundary_write32 = function(a, c, d) {
  this.memory.write8(a, d);
  this.memory.write8(c, d >> 24);
  a & 1 ? a & 2 ? (this.memory.write8(c - 2, d >> 8), this.memory.write8(c - 1, d >> 16)) : (this.memory.write8(a + 1, d >> 8), this.memory.write8(a + 2, d >> 16)) : (this.memory.write8(a + 1, d >> 8), this.memory.write8(c - 1, d >> 16));
};
CPU.prototype.safe_read8 = function(a) {
  return this.memory.read8(this.translate_address_read(a));
};
CPU.prototype.safe_read16 = function(a) {
  return this.paging && 4095 === (a & 4095) ? this.safe_read8(a) | this.safe_read8(a + 1) << 8 : this.memory.read16(this.translate_address_read(a));
};
CPU.prototype.safe_read32s = function(a) {
  return this.paging && 4093 <= (a & 4095) ? this.safe_read16(a) | this.safe_read16(a + 2) << 16 : this.memory.read32s(this.translate_address_read(a));
};
CPU.prototype.safe_write8 = function(a, c) {
  this.memory.write8(this.translate_address_write(a), c);
};
CPU.prototype.safe_write16 = function(a, c) {
  var d = this.translate_address_write(a);
  4095 === (a & 4095) ? this.virt_boundary_write16(d, this.translate_address_write(a + 1), c) : this.memory.write16(d, c);
};
CPU.prototype.safe_write32 = function(a, c) {
  var d = this.translate_address_write(a);
  4093 <= (a & 4095) ? this.virt_boundary_write32(d, this.translate_address_write(a + 3), c) : this.memory.write32(d, c);
};
CPU.prototype.read_moffs = function() {
  return this.address_size_32 ? this.get_seg_prefix(3) + this.read_imm32s() | 0 : this.get_seg_prefix(3) + this.read_imm16() | 0;
};
CPU.prototype.getiopl = function() {
  return this.flags >> 12 & 3;
};
CPU.prototype.vm86_mode = function() {
  return!!(this.flags & 131072);
};
CPU.prototype.get_eflags = function() {
  return this.flags & -2262 | !!this.getcf() | !!this.getpf() << 2 | !!this.getaf() << 4 | !!this.getzf() << 6 | !!this.getsf() << 7 | !!this.getof() << 11;
};
CPU.prototype.load_eflags = function() {
  this.flags = this.get_eflags();
  this.flags_changed = 0;
};
CPU.prototype.update_eflags = function(a) {
  var c = 1769472, d = 2588629;
  this.flags & 131072 ? (c |= 12288, d |= 1572864) : this.cpl && (c |= 12288, this.cpl > this.getiopl() && (c |= 512));
  this.flags = (a ^ (this.flags ^ a) & c) & d | 2;
  this.flags_changed = 0;
};
CPU.prototype.get_stack_pointer = function(a) {
  return this.get_seg(2) + this.stack_reg[this.reg_vsp] + a | 0;
};
CPU.prototype.get_real_eip = function() {
  return this.instruction_pointer - this.get_seg(1) | 0;
};
CPU.prototype.call_interrupt_vector = function(a, c, d) {
  this.in_hlt = !1;
  if (this.protected_mode) {
    if (this.vm86_mode() && this.cr4 & 1) {
      throw this.debug.unimpl("VME");
    }
    this.vm86_mode() && c && 3 > this.getiopl() && this.trigger_gp(0);
    if ((a << 3 | 7) > this.idtr_size) {
      throw this.debug.unimpl("#GP handler");
    }
    var e = this.idtr_offset + (a << 3) | 0;
    this.paging && (e = this.translate_address_system_read(e));
    var f = this.memory.read16(e) | this.memory.read16(e + 6) << 16, g = this.memory.read16(e + 2), e = this.memory.read8(e + 5), k = e >> 5 & 3;
    if (0 === (e & 128)) {
      throw this.debug.unimpl("#NP handler");
    }
    c && k < this.cpl && this.trigger_gp(a << 3 | 2);
    e &= 31;
    if (14 === e) {
      a = !1;
    } else {
      if (15 === e) {
        a = !0;
      } else {
        if (5 === e) {
          throw this.debug.unimpl("call int to task gate");
        }
        if (6 === e) {
          throw this.debug.unimpl("16 bit interrupt gate");
        }
        if (7 === e) {
          throw this.debug.unimpl("16 bit trap gate");
        }
        throw this.debug.unimpl("#GP handler");
      }
    }
    c = this.lookup_segment_selector(g);
    if (c.is_null) {
      throw this.debug.unimpl("#GP handler");
    }
    if (!c.is_executable || c.dpl > this.cpl) {
      throw this.debug.unimpl("#GP handler");
    }
    if (!c.is_present) {
      throw this.debug.unimpl("#NP handler");
    }
    this.load_eflags();
    e = this.flags;
    if (!c.dc_bit && c.dpl < this.cpl) {
      var m = (c.dpl << 3) + 4;
      if (m + 5 > this.segment_limits[6]) {
        throw this.debug.unimpl("#TS handler");
      }
      m = m + this.segment_offsets[6] | 0;
      this.paging && (m = this.translate_address_system_read(m));
      var k = this.memory.read32s(m), m = this.memory.read16(m + 4), l = this.lookup_segment_selector(m);
      if (l.is_null) {
        throw this.debug.unimpl("#TS handler");
      }
      if (l.rpl !== c.dpl) {
        throw this.debug.unimpl("#TS handler");
      }
      if (l.dpl !== c.dpl || !l.rw_bit) {
        throw this.debug.unimpl("#TS handler");
      }
      if (!l.is_present) {
        throw this.debug.unimpl("#TS handler");
      }
      var l = this.reg32s[4], n = this.sreg[2];
      this.cpl = c.dpl;
      this.cpl_changed();
      this.is_32 !== c.size && this.update_cs_size(c.size);
      this.flags &= -196609;
      this.reg32s[4] = k;
      this.switch_seg(2, m);
      e & 131072 && (this.push32(this.sreg[5]), this.push32(this.sreg[4]), this.push32(this.sreg[3]), this.push32(this.sreg[0]));
      this.push32(n);
      this.push32(l);
    } else {
      if (c.dc_bit || c.dpl === this.cpl) {
        this.flags & 131072 && this.trigger_gp(g & -4);
      } else {
        throw this.debug.unimpl("#GP handler");
      }
    }
    this.push32(e);
    this.push32(this.sreg[1]);
    this.push32(this.get_real_eip());
    e & 131072 && (this.switch_seg(5, 0), this.switch_seg(4, 0), this.switch_seg(3, 0), this.switch_seg(0, 0));
    !1 !== d && this.push32(d);
    this.sreg[1] = g;
    this.is_32 !== c.size && this.update_cs_size(c.size);
    this.segment_limits[1] = c.effective_limit;
    this.segment_offsets[1] = c.base;
    this.instruction_pointer = this.get_seg(1) + f | 0;
    a ? this.handle_irqs() : this.flags &= -513;
  } else {
    this.load_eflags(), this.push16(this.flags), this.push16(this.sreg[1]), this.push16(this.get_real_eip()), this.flags &= -513, this.switch_seg(1, this.memory.read16((a << 2) + 2)), this.instruction_pointer = this.get_seg(1) + this.memory.read16(a << 2) | 0;
  }
  this.last_instr_jump = !0;
};
CPU.prototype.iret16 = function() {
  if (!this.protected_mode || this.vm86_mode() && 3 === this.getiopl()) {
    var a = this.pop16();
    this.switch_seg(1, this.pop16());
    var c = this.pop16();
    this.instruction_pointer = a + this.get_seg(1) | 0;
    this.update_eflags(c);
    this.handle_irqs();
  } else {
    throw this.vm86_mode() && this.trigger_gp(0), this.debug.unimpl("16 bit iret in protected mode");
  }
  this.last_instr_jump = !0;
};
CPU.prototype.iret32 = function() {
  if (!this.protected_mode || this.vm86_mode() && 3 === this.getiopl()) {
    var a = this.pop32s();
    this.switch_seg(1, this.pop32s() & 65535);
    var c = this.pop32s();
    this.instruction_pointer = a + this.get_seg(1) | 0;
    this.update_eflags(c);
    this.handle_irqs();
  } else {
    this.vm86_mode() && this.trigger_gp(0);
    this.instruction_pointer = this.pop32s();
    this.sreg[1] = this.pop32s();
    c = this.pop32s();
    if (c & 131072) {
      if (0 === this.cpl) {
        this.update_eflags(c);
        this.flags |= 131072;
        this.switch_seg(1, this.sreg[1]);
        this.instruction_pointer = this.instruction_pointer + this.get_seg(1) | 0;
        var a = this.pop32s(), d = this.pop32s();
        this.switch_seg(0, this.pop32s() & 65535);
        this.switch_seg(3, this.pop32s() & 65535);
        this.switch_seg(4, this.pop32s() & 65535);
        this.switch_seg(5, this.pop32s() & 65535);
        this.reg32s[4] = a;
        this.switch_seg(2, d & 65535);
        this.cpl = 3;
        this.update_cs_size(!1);
        return;
      }
      c &= -131073;
    }
    var e = this.lookup_segment_selector(this.sreg[1]);
    if (e.is_null) {
      throw this.debug.unimpl("is null");
    }
    if (!e.is_present) {
      throw this.debug.unimpl("not present");
    }
    if (!e.is_executable) {
      throw this.debug.unimpl("not exec");
    }
    if (e.rpl < this.cpl) {
      throw this.debug.unimpl("rpl < cpl");
    }
    if (e.dc_bit && e.dpl > e.rpl) {
      throw this.debug.unimpl("conforming and dpl > rpl");
    }
    e.rpl > this.cpl ? (a = this.pop32s(), d = this.pop32s(), this.reg32s[4] = a, this.update_eflags(c), this.cpl = e.rpl, this.switch_seg(2, d & 65535), this.cpl_changed()) : this.update_eflags(c);
    e.size !== this.is_32 && this.update_cs_size(e.size);
    this.segment_limits[1] = e.effective_limit;
    this.segment_offsets[1] = e.base;
    this.instruction_pointer = this.instruction_pointer + this.get_seg(1) | 0;
    this.handle_irqs();
    this.last_instr_jump = !0;
  }
};
CPU.prototype.hlt_op = function() {
  this.cpl && this.trigger_gp(0);
  if (0 === (this.flags & 512)) {
    throw this.debug.show("cpu halted"), "HALT";
  }
  this.in_hlt = !0;
  throw 233495534;
};
CPU.prototype.raise_exception = function(a) {
  this.call_interrupt_vector(a, !1, !1);
  throw 233495534;
};
CPU.prototype.raise_exception_with_code = function(a, c) {
  this.call_interrupt_vector(a, !1, c);
  throw 233495534;
};
CPU.prototype.trigger_de = function() {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception(0);
};
CPU.prototype.trigger_ud = function() {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception(6);
};
CPU.prototype.trigger_nm = function() {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception(7);
};
CPU.prototype.trigger_gp = function(a) {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception_with_code(13, a);
};
CPU.prototype.trigger_np = function(a) {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception_with_code(11, a);
};
CPU.prototype.trigger_ss = function(a) {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception_with_code(12, a);
};
CPU.prototype.seg_prefix = function(a) {
  this.segment_prefix = a;
  this.table[this.read_imm8()](this);
  this.segment_prefix = -1;
};
CPU.prototype.get_seg_prefix_ds = function() {
  return this.get_seg_prefix(3);
};
CPU.prototype.get_seg_prefix_ss = function() {
  return this.get_seg_prefix(2);
};
CPU.prototype.get_seg_prefix = function(a) {
  return-1 === this.segment_prefix ? this.get_seg(a) : 9 === this.segment_prefix ? 0 : this.get_seg(this.segment_prefix);
};
CPU.prototype.get_seg = function(a) {
  return this.segment_offsets[a];
};
CPU.prototype.handle_irqs = function() {
  this.devices.pic && this.flags & 512 && !this.page_fault && this.devices.pic.check_irqs();
};
CPU.prototype.test_privileges_for_io = function(a, c) {
  if (this.protected_mode && (this.cpl > this.getiopl() || this.flags & 131072)) {
    var d = this.segment_limits[6], e = this.segment_offsets[6];
    if (103 <= d) {
      var f = this.memory.read16(this.translate_address_system_read(e + 100 + 2));
      if (d >= f + (a + c - 1 >> 3) && (d = (1 << c) - 1 << (a & 7), e = this.translate_address_system_read(e + f + (a >> 3)), !((d & 65280 ? this.memory.read16(e) : this.memory.read8(e)) & d))) {
        return;
      }
    }
    this.trigger_gp(0);
  }
};
CPU.prototype.cpuid = function() {
  var a = 0, c = 0, d = 0, e = 0;
  switch(this.reg32s[0]) {
    case 0:
      a = 5;
      e = 1970169159;
      d = 1231384169;
      c = 1818588270;
      break;
    case 1:
      a = 3939;
      e = 0;
      c = 8388608;
      d = (this.fpu ? 1 : 0) | 43322;
      break;
    case 2:
      a = 1717260289;
      c = e = 0;
      d = 8024064;
      break;
    case 4:
      switch(this.reg32s[1]) {
        case 0:
          a = 289;
          e = 29360191;
          c = 63;
          d = 1;
          break;
        case 1:
          a = 290;
          e = 29360191;
          c = 63;
          d = 1;
          break;
        case 2:
          a = 323, e = 96469055, c = 4095, d = 1;
      }
      break;
    case -2147483648:
      a = 5;
  }
  this.reg32s[0] = a;
  this.reg32s[1] = c;
  this.reg32s[2] = d;
  this.reg32s[3] = e;
};
CPU.prototype.update_cs_size = function(a) {
  this.is_32 = this.operand_size_32 = this.address_size_32 = a;
  this.update_operand_size();
  this.update_address_size();
};
CPU.prototype.update_operand_size = function() {
  this.operand_size_32 ? (this.table = this.table32, this.table0F = this.table0F_32) : (this.table = this.table16, this.table0F = this.table0F_16);
};
CPU.prototype.update_address_size = function() {
  this.address_size_32 ? (this.regv = this.reg32s, this.reg_vcx = 1, this.reg_vsi = 6, this.reg_vdi = 7) : (this.regv = this.reg16, this.reg_vcx = 2, this.reg_vsi = 12, this.reg_vdi = 14);
};
CPU.prototype.lookup_segment_selector = function(a) {
  var c = 0 === (a & 4), d = a & -8, e, f;
  e = {rpl:a & 3, from_gdt:c, is_null:!1, is_valid:!0, base:0, access:0, flags:0, type:0, dpl:0, is_system:!1, is_present:!1, is_executable:!1, rw_bit:!1, dc_bit:!1, size:!1, effective_limit:0, is_writable:!1, is_readable:!1, table_offset:0};
  c ? (c = this.gdtr_offset, f = this.gdtr_size) : (c = this.segment_offsets[7], f = this.segment_limits[7]);
  if (0 === d) {
    return e.is_null = !0, e;
  }
  if ((a | 7) > f) {
    return e.is_valid = !1, e;
  }
  c = c + d | 0;
  this.paging && (c = this.translate_address_system_read(c));
  e.table_offset = c;
  e.base = this.memory.read16(c + 2) | this.memory.read8(c + 4) << 16 | this.memory.read8(c + 7) << 24;
  e.access = this.memory.read8(c + 5);
  e.flags = this.memory.read8(c + 6) >> 4;
  e.type = e.access & 15;
  e.dpl = e.access >> 5 & 3;
  e.is_system = 0 === (e.access & 16);
  e.is_present = 128 === (e.access & 128);
  e.is_executable = 8 === (e.access & 8);
  e.rw_bit = 2 === (e.access & 2);
  e.dc_bit = 4 === (e.access & 4);
  e.size = 4 === (e.flags & 4);
  a = this.memory.read16(c) | (this.memory.read8(c + 6) & 15) << 16;
  e.effective_limit = e.flags & 8 ? (a << 12 | 4095) >>> 0 : a;
  e.is_writable = e.rw_bit && !e.is_executable;
  e.is_readable = e.rw_bit || !e.is_executable;
  return e;
};
CPU.prototype.switch_seg = function(a, c) {
  1 === a && (this.protected_mode = 1 === (this.cr0 & 1));
  if (!this.protected_mode || this.vm86_mode()) {
    this.sreg[a] = c, this.segment_is_null[a] = 0, this.segment_limits[a] = 1048575, this.segment_offsets[a] = c << 4;
  } else {
    var d = this.lookup_segment_selector(c);
    if (2 === a) {
      if (d.is_null) {
        this.trigger_gp(0);
        return;
      }
      if (!d.is_valid || d.is_system || d.rpl !== this.cpl || !d.is_writable || d.dpl !== this.cpl) {
        this.trigger_gp(c & -4);
        return;
      }
      if (!d.is_present) {
        this.trigger_ss(c & -4);
        return;
      }
      (this.stack_size_32 = d.size) ? (this.stack_reg = this.reg32s, this.reg_vsp = 4, this.reg_vbp = 5) : (this.stack_reg = this.reg16, this.reg_vsp = 8, this.reg_vbp = 10);
    } else {
      if (1 === a) {
        if (!d.is_executable) {
          throw this.debug.unimpl("#GP handler");
        }
        if (d.is_system) {
          throw this.debug.unimpl("load system segment descriptor, type = " + (d.access & 15));
        }
        if (d.rpl !== this.cpl) {
          throw this.debug.unimpl("privilege change");
        }
        if (!d.dc_bit && d.dpl < this.cpl) {
          throw this.debug.unimpl("inter privilege call");
        }
        if (!d.dc_bit && d.dpl !== this.cpl) {
          throw this.debug.unimpl("#GP handler");
        }
        d.size !== this.is_32 && this.update_cs_size(d.size);
      } else {
        if (d.is_null) {
          this.sreg[a] = c;
          this.segment_is_null[a] = 1;
          return;
        }
        if (!d.is_valid || d.is_system || !d.is_readable || (!d.is_executable || !d.dc_bit) && d.rpl > d.dpl && this.cpl > d.dpl) {
          this.trigger_gp(c & -4);
          return;
        }
        if (!d.is_present) {
          this.trigger_np(c & -4);
          return;
        }
      }
    }
    this.segment_is_null[a] = 0;
    this.segment_limits[a] = d.effective_limit;
    this.segment_offsets[a] = d.base;
    this.sreg[a] = c;
  }
};
CPU.prototype.load_tr = function(a) {
  var c = this.lookup_segment_selector(a);
  if (!c.from_gdt) {
    throw this.debug.unimpl("TR can only be loaded from GDT");
  }
  if (c.is_null) {
    throw this.debug.unimpl("#GP handler");
  }
  if (!c.is_present) {
    throw this.debug.unimpl("#GP handler");
  }
  if (!c.is_system) {
    throw this.debug.unimpl("#GP handler");
  }
  if (9 !== c.type) {
    throw this.debug.unimpl("#GP handler");
  }
  this.segment_offsets[6] = c.base;
  this.segment_limits[6] = c.effective_limit;
  this.sreg[6] = a;
  this.memory.write8(c.table_offset + 5, this.memory.read8(c.table_offset + 5) | 2);
};
CPU.prototype.load_ldt = function(a) {
  var c = this.lookup_segment_selector(a);
  if (c.is_null) {
    this.segment_offsets[7] = 0, this.segment_limits[7] = 0;
  } else {
    if (!c.from_gdt) {
      throw this.debug.unimpl("LDTR can only be loaded from GDT");
    }
    if (!c.is_present) {
      throw this.debug.unimpl("#GP handler");
    }
    if (!c.is_system) {
      throw this.debug.unimpl("#GP handler");
    }
    if (2 !== c.type) {
      throw this.debug.unimpl("#GP handler");
    }
    this.segment_offsets[7] = c.base;
    this.segment_limits[7] = c.effective_limit;
    this.sreg[7] = a;
  }
};
CPU.prototype.arpl = function(a, c) {
  this.flags_changed &= -65;
  if ((a & 3) < (this.reg16[c] & 3)) {
    return this.flags |= 64, a & -4 | this.reg16[c] & 3;
  }
  this.flags &= -65;
  return a;
};
CPU.prototype.clear_tlb = function() {
  this.last_virt_eip = -1;
  this.tlb_info.set(this.tlb_info_global);
};
CPU.prototype.full_clear_tlb = function() {
  for (var a = new Int32Array(this.tlb_info_global.buffer), c = 0;262144 > c;) {
    a[c++] = a[c++] = a[c++] = a[c++] = 0;
  }
  this.clear_tlb();
};
CPU.prototype.invlpg = function(a) {
  a = a >>> 12;
  this.tlb_info[a] = 0;
  this.tlb_info_global[a] = 0;
  this.last_virt_eip = -1;
};
CPU.prototype.translate_address_read = function(a) {
  return this.paging ? 3 === this.cpl ? this.translate_address_user_read(a) : this.translate_address_system_read(a) : a;
};
CPU.prototype.translate_address_write = function(a) {
  return this.paging ? 3 === this.cpl ? this.translate_address_user_write(a) : this.translate_address_system_write(a) : a;
};
CPU.prototype.translate_address_user_write = function(a) {
  var c = a >>> 12;
  return this.tlb_info[c] & 8 ? this.tlb_data[c] ^ a : this.do_page_translation(a, 1, 1) | a & 4095;
};
CPU.prototype.translate_address_user_read = function(a) {
  var c = a >>> 12;
  return this.tlb_info[c] & 4 ? this.tlb_data[c] ^ a : this.do_page_translation(a, 0, 1) | a & 4095;
};
CPU.prototype.translate_address_system_write = function(a) {
  var c = a >>> 12;
  return this.tlb_info[c] & 2 ? this.tlb_data[c] ^ a : this.do_page_translation(a, 1, 0) | a & 4095;
};
CPU.prototype.translate_address_system_read = function(a) {
  var c = a >>> 12;
  return this.tlb_info[c] & 1 ? this.tlb_data[c] ^ a : this.do_page_translation(a, 0, 0) | a & 4095;
};
CPU.prototype.do_page_translation = function(a, c, d) {
  var e = a >>> 12, f = (this.cr3 >>> 2) + (e >> 10), g = this.memory.mem32s[f], k = !0, m = !0;
  g & 1 || (this.cr2 = a, this.trigger_pagefault(c, d, 0));
  0 === (g & 2) && (k = !1, c && (d || this.cr0 & 65536) && (this.cr2 = a, this.trigger_pagefault(c, d, 1)));
  0 === (g & 4) && (m = !1, d && (this.cr2 = a, this.trigger_pagefault(c, d, 1)));
  if (g & this.page_size_extensions) {
    this.memory.mem32s[f] = g | 32 | c << 6, a = g & 4290772992 | a & 4190208, g = g & 256;
  } else {
    var l = ((g & 4294963200) >>> 2) + (e & 1023), n = this.memory.mem32s[l];
    0 === (n & 1) && (this.cr2 = a, this.trigger_pagefault(c, d, 0));
    0 === (n & 2) && (k = !1, c && (d || this.cr0 & 65536) && (this.cr2 = a, this.trigger_pagefault(c, d, 1)));
    0 === (n & 4) && (m = !1, d && (this.cr2 = a, this.trigger_pagefault(c, d, 1)));
    this.memory.mem32s[f] = g | 32;
    this.memory.mem32s[l] = n | 32 | c << 6;
    a = n & 4294963200;
    g = n & 256;
  }
  this.tlb_data[e] = a ^ e << 12;
  k = m ? k ? 15 : 5 : k ? 3 : 1;
  this.tlb_info[e] = k;
  g && this.cr4 & 128 && (this.tlb_info_global[e] = k);
  return a;
};
CPU.prototype.writable_or_pagefault = function(a, c) {
  if (this.paging) {
    var d = 3 === this.cpl ? 1 : 0, e = d ? 8 : 2, f = a >>> 12;
    0 === (this.tlb_info[f] & e) && this.do_page_translation(a, 1, d);
    4096 <= (a & 4095) + c - 1 && 0 === (this.tlb_info[f + 1] & e) && this.do_page_translation(a + c - 1, 1, d);
  }
};
CPU.prototype.trigger_pagefault = function(a, c, d) {
  if (this.page_fault) {
    throw this.debug.unimpl("Double fault");
  }
  var e = this.cr2 >>> 12;
  this.tlb_info[e] = 0;
  this.tlb_info_global[e] = 0;
  this.instruction_pointer = this.previous_ip;
  this.page_fault = !0;
  this.call_interrupt_vector(14, !1, c << 2 | a << 1 | d);
  throw 233495534;
};
function IO(a) {
  function c() {
    return 255;
  }
  function d() {
    return 65535;
  }
  function e() {
    return-1;
  }
  function f() {
  }
  var g = a.size;
  this.IO$ports = [];
  this.devices = Array(65536);
  this._state_skip = [this.IO$ports, this.devices];
  for (var k = 0;65536 > k;k++) {
    this.IO$ports[k] = {read8:c, read16:d, read32:e, write8:f, write16:f, write32:f, device:void 0};
  }
  this.register_read = function(a, c, d, e, f) {
    d && (this.IO$ports[a].read8 = d);
    e && (this.IO$ports[a].read16 = e);
    f && (this.IO$ports[a].read32 = f);
    this.IO$ports[a].device = c;
  };
  this.register_write = function(a, c, d, e, f) {
    d && (this.IO$ports[a].write8 = d);
    e && (this.IO$ports[a].write16 = e);
    f && (this.IO$ports[a].write32 = f);
    this.IO$ports[a].device = c;
  };
  this.register_read_consecutive = function(a, c, d, e, f, g) {
    function k() {
      return d.call(this) | e.call(this) << 8;
    }
    function t() {
      return f.call(this) | g.call(this) << 8;
    }
    function x() {
      return d.call(this) | e.call(this) << 8 | f.call(this) << 16 | g.call(this) << 24;
    }
    f && g ? (this.register_read(a, c, d, k, x), this.register_read(a + 1, c, e), this.register_read(a + 2, c, f, t), this.register_read(a + 3, c, g)) : (this.register_read(a, c, d, k), this.register_read(a + 1, c, e));
  };
  this.register_write_consecutive = function(a, c, d, e, f, g) {
    function k(a) {
      d.call(this, a & 255);
      e.call(this, a >> 8 & 255);
    }
    function t(a) {
      f.call(this, a & 255);
      g.call(this, a >> 8 & 255);
    }
    function x(a) {
      d.call(this, a & 255);
      e.call(this, a >> 8 & 255);
      f.call(this, a >> 16 & 255);
      g.call(this, a >>> 24);
    }
    f && g ? (this.register_write(a, c, d, k, x), this.register_write(a + 1, c, e), this.register_write(a + 2, c, f, t), this.register_write(a + 3, c, g)) : (this.register_write(a, c, d, k), this.register_write(a + 1, c, e));
  };
  this.mmap_read32_shim = function(c) {
    var d = a.memory_map_read8[c >>> 14];
    return d(c) | d(c + 1) << 8 | d(c + 2) << 16 | d(c + 3) << 24;
  };
  this.mmap_write32_shim = function(c, d) {
    var e = a.memory_map_write8[c >>> 14];
    e(c, d & 255);
    e(c + 1, d >> 8 & 255);
    e(c + 2, d >> 16 & 255);
    e(c + 3, d >>> 24);
  };
  this.mmap_register = function(c, d, e, f, g, k) {
    g || (g = this.mmap_read32_shim);
    k || (k = this.mmap_write32_shim);
    for (c >>>= 14;0 < d;c++) {
      a.memory_map_registered[c] = 1, a.memory_map_read8[c] = e, a.memory_map_write8[c] = f, a.memory_map_read32[c] = g, a.memory_map_write32[c] = k, d -= 16384;
    }
  };
  for (k = 0;k << 14 < g;k++) {
    a.memory_map_read8[k] = a.memory_map_write8[k] = void 0, a.memory_map_read32[k] = a.memory_map_write32[k] = void 0;
  }
  this.mmap_register(g, 4294967296 - g, function() {
    return 255;
  }, function() {
  }, function() {
    return-1;
  }, function() {
  });
  this.in_mmap_range = function(c, d) {
    c >>>= 0;
    var e = c + (d >>> 0);
    if (e >= g) {
      return!0;
    }
    for (c &= -16384;c < e;) {
      if (a.memory_map_registered[c >> 14]) {
        return!0;
      }
      c += 16384;
    }
    return!1;
  };
  this.port_write8 = function(a, c) {
    var d = this.IO$ports[a];
    d.write8.call(d.device, c);
  };
  this.port_write16 = function(a, c) {
    var d = this.IO$ports[a];
    d.write16.call(d.device, c);
  };
  this.port_write32 = function(a, c) {
    var d = this.IO$ports[a];
    d.write32.call(d.device, c);
  };
  this.port_read8 = function(a) {
    a = this.IO$ports[a];
    return a.read8.call(a.device);
  };
  this.port_read16 = function(a) {
    a = this.IO$ports[a];
    return a.read16.call(a.device);
  };
  this.port_read32 = function(a) {
    a = this.IO$ports[a];
    return a.read32.call(a.device);
  };
}
;function v86(a) {
  this.first_init = !0;
  this.stopped = this.running = !1;
  this.cpu = new CPU;
  this.bus = a;
  a.register("cpu-init", this.init, this);
  a.register("cpu-run", this.v86_prototype$run, this);
  a.register("cpu-stop", this.v86_prototype$stop, this);
  this.fast_next_tick = function() {
    console.assert(!1);
  };
  this.v86$next_tick = function() {
    console.assert(!1);
  };
}
v86.prototype.v86_prototype$run = function() {
  this.running || this.fast_next_tick();
};
v86.prototype.do_tick = function() {
  if (this.stopped) {
    this.stopped = this.running = !1;
  } else {
    this.running = !0;
    var a = this.cpu.main_run();
    this.v86$next_tick(a);
  }
};
v86.prototype.v86_prototype$stop = function() {
  this.running && (this.stopped = !0);
};
v86.prototype.v86_prototype$restart = function() {
  this.cpu.CPU_prototype$reset();
  this.cpu.load_bios();
};
v86.prototype.init = function(a) {
  this.first_init && (this.first_init = !1, this.lazy_init());
  this.cpu.init(a, this.bus);
  this.bus.send_async();
};
v86.prototype.lazy_init = function() {
  var a = this;
  "undefined" !== typeof setImmediate ? this.fast_next_tick = function() {
    setImmediate(function() {
      a.do_tick();
    });
  } : "undefined" !== typeof window && "undefined" !== typeof postMessage ? (window.addEventListener("message", function(c) {
    c.source === window && 43605 === c.data && a.do_tick();
  }, !1), this.fast_next_tick = function() {
    window.postMessage(43605, "*");
  }) : this.fast_next_tick = function() {
    setTimeout(function() {
      a.do_tick();
    }, 0);
  };
  this.v86$next_tick = "undefined" !== typeof document && "boolean" === typeof document.hidden ? function(c) {
    4 > c || document.hidden ? this.fast_next_tick() : setTimeout(function() {
      a.do_tick();
    }, c);
  } : function(c) {
    setTimeout(function() {
      a.do_tick();
    }, c);
  };
};
v86.prototype.v86_prototype$save_state = function() {
  return this.cpu.CPU_prototype$save_state();
};
v86.prototype.v86_prototype$restore_state = function(a) {
  this.cpu.CPU_prototype$restore_state(a);
};
"object" === typeof performance && performance.now ? v86.microtick = function() {
  return performance.now();
} : v86.microtick = Date.now;
String.pads = function(a) {
  for (a = a ? a + "" : "";20 > a.length;) {
    a += " ";
  }
  return a;
};
String.pad0 = function() {
  for (var a = "", a = a ? a + "" : "";1 > a.length;) {
    a = "0" + a;
  }
  return a;
};
function h(a) {
  return a ? a.toString(16).toUpperCase() : String.pad0();
}
function SyncBuffer(a) {
  this.buffer = a;
  this.byteLength = a.byteLength;
}
SyncBuffer.prototype.get = function(a, c, d) {
  d(new Uint8Array(this.buffer, a, c));
};
SyncBuffer.prototype.set = function(a, c, d) {
  (new Uint8Array(this.buffer, a, c.byteLength)).set(c);
  d();
};
for (var int_log2_table = new Int8Array(256), i = 0, b = -2;256 > i;i++) {
  i & i - 1 || b++, int_log2_table[i] = b;
}
Math.int_log2 = function(a) {
  var c = a >>> 16;
  if (c) {
    var d = c >>> 8;
    return d ? 24 + int_log2_table[d] : 16 + int_log2_table[c];
  }
  return(d = a >>> 8) ? 8 + int_log2_table[d] : int_log2_table[a];
};
function ByteQueue(a) {
  var c = new Uint8Array(a), d, e;
  this.length = 0;
  this.push = function(d) {
    this.length !== a && this.length++;
    c[e] = d;
    e = e + 1 & a - 1;
  };
  this.shift = function() {
    if (this.length) {
      var e = c[d];
      d = d + 1 & a - 1;
      this.length--;
      return e;
    }
    return-1;
  };
  this.clear = function() {
    this.length = e = d = 0;
  };
  this.clear();
}
Array.setify = function(a) {
  for (var c = {}, d = 0;d < a.length;d++) {
    c[a[d]] = !0;
  }
  return c;
};
function FPU(a) {
  this.cpu = a;
  this.st = new Float64Array(8);
  this._state_restore();
  this.stack_empty = 255;
  this.stack_ptr = 0;
  this.control_word = 895;
  this.fpu_dp_selector = this.fpu_dp = this.fpu_opcode = this.fpu_ip_selector = this.fpu_ip = this.status_word = 0;
  this.indefinite_nan = NaN;
  this.constants = new Float64Array([1, Math.log(10) / Math.LN2, Math.LOG2E, Math.PI, Math.log(2) / Math.LN10, Math.LN2, 0]);
}
FPU.prototype._state_restore = function() {
  this.float32 = new Float32Array(1);
  this.float32_byte = new Uint8Array(this.float32.buffer);
  this.float32_int = new Int32Array(this.float32.buffer);
  this.float64 = new Float64Array(1);
  this.float64_byte = new Uint8Array(this.float64.buffer);
  this.float64_int = new Int32Array(this.float64.buffer);
  this.st8 = new Uint8Array(this.st.buffer);
  this.st32 = new Int32Array(this.st.buffer);
  this._state_skip = [this.cpu, this.float32, this.float32_byte, this.float32_int, this.float64, this.float64_byte, this.float64_int, this.st8, this.st32];
};
FPU.prototype.fpu_unimpl = function() {
  this.cpu.trigger_ud();
};
FPU.prototype.stack_fault = function() {
  this.status_word |= 65;
};
FPU.prototype.invalid_arithmatic = function() {
  this.status_word |= 1;
};
FPU.prototype.fcom = function(a) {
  var c = this.get_st0();
  this.status_word &= -18177;
  c > a || (this.status_word = a > c ? this.status_word | 256 : c === a ? this.status_word | 16384 : this.status_word | 17664);
};
FPU.prototype.fucom = function(a) {
  this.fcom(a);
};
FPU.prototype.fcomi = function(a) {
  var c = this.st[this.stack_ptr];
  this.cpu.flags_changed &= -70;
  this.cpu.flags &= -70;
  c > a || (this.cpu.flags = a > c ? this.cpu.flags | 1 : c === a ? this.cpu.flags | 64 : this.cpu.flags | 69);
};
FPU.prototype.fucomi = function(a) {
  this.fcomi(a);
};
FPU.prototype.ftst = function(a) {
  this.status_word &= -18177;
  isNaN(a) ? this.status_word |= 17664 : 0 === a ? this.status_word |= 16384 : 0 > a && (this.status_word |= 256);
};
FPU.prototype.fxam = function(a) {
  this.status_word &= -18177;
  this.status_word |= this.sign(0) << 9;
  this.status_word = this.stack_empty >> this.stack_ptr & 1 ? this.status_word | 16640 : isNaN(a) ? this.status_word | 256 : 0 === a ? this.status_word | 16384 : Infinity === a || -Infinity === a ? this.status_word | 1280 : this.status_word | 1024;
};
FPU.prototype.finit = function() {
  this.control_word = 895;
  this.fpu_opcode = this.fpu_dp = this.fpu_ip = this.status_word = 0;
  this.stack_empty = 255;
  this.stack_ptr = 0;
};
FPU.prototype.load_status_word = function() {
  return this.status_word & -14337 | this.stack_ptr << 11;
};
FPU.prototype.safe_status_word = function(a) {
  this.status_word = a & -14337;
  this.stack_ptr = a >> 11 & 7;
};
FPU.prototype.load_tag_word = function() {
  for (var a = 0, c, d = 0;8 > d;d++) {
    c = this.st[d], this.stack_empty >> d & 1 ? a |= 3 << (d << 1) : 0 === c ? a |= 1 << (d << 1) : isFinite(c) || (a |= 2 << (d << 1));
  }
  return a;
};
FPU.prototype.safe_tag_word = function(a) {
  for (var c = this.stack_empty = 0;8 > c;c++) {
    this.stack_empty |= a >> c & a >> c + 1 & 1 << c;
  }
};
FPU.prototype.fstenv = function(a) {
  this.cpu.operand_size_32 ? (this.cpu.writable_or_pagefault(a, 26), this.cpu.safe_write16(a, this.control_word), this.cpu.safe_write16(a + 4, this.load_status_word()), this.cpu.safe_write16(a + 8, this.load_tag_word()), this.cpu.safe_write32(a + 12, this.fpu_ip), this.cpu.safe_write16(a + 16, this.fpu_ip_selector), this.cpu.safe_write16(a + 18, this.fpu_opcode), this.cpu.safe_write32(a + 20, this.fpu_dp), this.cpu.safe_write16(a + 24, this.fpu_dp_selector)) : this.fpu_unimpl();
};
FPU.prototype.fldenv = function(a) {
  this.cpu.operand_size_32 ? (this.control_word = this.cpu.safe_read16(a), this.safe_status_word(this.cpu.safe_read16(a + 4)), this.safe_tag_word(this.cpu.safe_read16(a + 8)), this.fpu_ip = this.cpu.safe_read32s(a + 12), this.fpu_ip_selector = this.cpu.safe_read16(a + 16), this.fpu_opcode = this.cpu.safe_read16(a + 18), this.fpu_dp = this.cpu.safe_read32s(a + 20), this.fpu_dp_selector = this.cpu.safe_read16(a + 24)) : this.fpu_unimpl();
};
FPU.prototype.fsave = function(a) {
  this.cpu.writable_or_pagefault(a, 108);
  this.fstenv(a);
  a += 28;
  for (var c = 0;8 > c;c++) {
    this.store_m80(a, c - this.stack_ptr & 7), a += 10;
  }
  this.finit();
};
FPU.prototype.frstor = function(a) {
  this.fldenv(a);
  a += 28;
  for (var c = 0;8 > c;c++) {
    this.st[c] = this.load_m80(a), a += 10;
  }
};
FPU.prototype.integer_round = function(a) {
  var c = this.control_word >> 10 & 3;
  return 0 === c ? (c = Math.round(a), .5 === c - a && c % 2 && c--, c) : 1 === c || 3 === c && 0 < a ? Math.floor(a) : Math.ceil(a);
};
FPU.prototype.FPU_prototype$truncate = function(a) {
  return 0 < a ? Math.floor(a) : Math.ceil(a);
};
FPU.prototype.push = function(a) {
  this.stack_ptr = this.stack_ptr - 1 & 7;
  this.stack_empty >> this.stack_ptr & 1 ? (this.status_word &= -513, this.stack_empty &= ~(1 << this.stack_ptr), this.st[this.stack_ptr] = a) : (this.status_word |= 512, this.stack_fault(), this.st[this.stack_ptr] = this.indefinite_nan);
};
FPU.prototype.pop = function() {
  this.stack_empty |= 1 << this.stack_ptr;
  this.stack_ptr = this.stack_ptr + 1 & 7;
};
FPU.prototype.get_sti = function(a) {
  a = a + this.stack_ptr & 7;
  return this.stack_empty >> a & 1 ? (this.status_word &= -513, this.stack_fault(), this.indefinite_nan) : this.st[a];
};
FPU.prototype.get_st0 = function() {
  return this.stack_empty >> this.stack_ptr & 1 ? (this.status_word &= -513, this.stack_fault(), this.indefinite_nan) : this.st[this.stack_ptr];
};
FPU.prototype.load_m80 = function(a) {
  var c = this.cpu.safe_read16(a + 8), d = this.cpu.safe_read32s(a) >>> 0, e = this.cpu.safe_read32s(a + 4) >>> 0;
  a = c >> 15;
  c &= -32769;
  if (0 === c) {
    return 0;
  }
  if (!(32767 > c)) {
    return this.float64_byte[7] = 127 | a << 7, this.float64_byte[6] = 240 | e >> 30 << 3 & 8, this.float64_byte[5] = 0, this.float64_byte[4] = 0, this.float64_int[0] = 0, this.float64[0];
  }
  d += 4294967296 * e;
  a && (d = -d);
  return d * Math.pow(2, c - 16383 - 63);
};
FPU.prototype.store_m80 = function(a, c) {
  this.float64[0] = this.st[this.stack_ptr + c & 7];
  var d = this.float64_byte[7] & 128, e = (this.float64_byte[7] & 127) << 4 | this.float64_byte[6] >> 4, f, g;
  2047 === e ? (e = 32767, f = 0, g = 2147483648 | (this.float64_int[1] & 524288) << 11) : 0 === e ? g = f = 0 : (e += 15360, f = this.float64_int[0] << 11, g = 2147483648 | (this.float64_int[1] & 1048575) << 11 | this.float64_int[0] >>> 21);
  this.cpu.safe_write32(a, f);
  this.cpu.safe_write32(a + 4, g);
  this.cpu.safe_write16(a + 8, d << 8 | e);
};
FPU.prototype.load_m64 = function(a) {
  var c = this.cpu.safe_read32s(a);
  a = this.cpu.safe_read32s(a + 4);
  this.float64_int[0] = c;
  this.float64_int[1] = a;
  return this.float64[0];
};
FPU.prototype.store_m64 = function(a) {
  this.cpu.writable_or_pagefault(a, 8);
  this.float64[0] = this.get_sti(0);
  this.cpu.safe_write32(a, this.float64_int[0]);
  this.cpu.safe_write32(a + 4, this.float64_int[1]);
};
FPU.prototype.load_m32 = function(a) {
  this.float32_int[0] = this.cpu.safe_read32s(a);
  return this.float32[0];
};
FPU.prototype.store_m32 = function(a, c) {
  this.float32[0] = c;
  this.cpu.safe_write32(a, this.float32_int[0]);
};
FPU.prototype.sign = function(a) {
  return this.st8[(this.stack_ptr + a & 7) << 3 | 7] >> 7;
};
FPU.prototype.op_D8_reg = function(a) {
  var c = a >> 3 & 7;
  a = this.get_sti(a & 7);
  var d = this.get_st0();
  switch(c) {
    case 0:
      this.st[this.stack_ptr] = d + a;
      break;
    case 1:
      this.st[this.stack_ptr] = d * a;
      break;
    case 2:
      this.fcom(a);
      break;
    case 3:
      this.fcom(a);
      this.pop();
      break;
    case 4:
      this.st[this.stack_ptr] = d - a;
      break;
    case 5:
      this.st[this.stack_ptr] = a - d;
      break;
    case 6:
      this.st[this.stack_ptr] = d / a;
      break;
    case 7:
      this.st[this.stack_ptr] = a / d;
  }
};
FPU.prototype.op_D8_mem = function(a, c) {
  var d = a >> 3 & 7, e = this.load_m32(c), f = this.get_st0();
  switch(d) {
    case 0:
      this.st[this.stack_ptr] = f + e;
      break;
    case 1:
      this.st[this.stack_ptr] = f * e;
      break;
    case 2:
      this.fcom(e);
      break;
    case 3:
      this.fcom(e);
      this.pop();
      break;
    case 4:
      this.st[this.stack_ptr] = f - e;
      break;
    case 5:
      this.st[this.stack_ptr] = e - f;
      break;
    case 6:
      this.st[this.stack_ptr] = f / e;
      break;
    case 7:
      this.st[this.stack_ptr] = e / f;
  }
};
FPU.prototype.op_D9_reg = function(a) {
  var c = a & 7;
  switch(a >> 3 & 7) {
    case 0:
      a = this.get_sti(c);
      this.push(a);
      break;
    case 1:
      a = this.get_sti(c);
      this.st[this.stack_ptr + c & 7] = this.get_st0();
      this.st[this.stack_ptr] = a;
      break;
    case 2:
      switch(c) {
        case 0:
          break;
        default:
          this.fpu_unimpl();
      }
      break;
    case 3:
      this.fpu_unimpl();
      break;
    case 4:
      a = this.get_st0();
      switch(c) {
        case 0:
          this.st[this.stack_ptr] = -a;
          break;
        case 1:
          this.st[this.stack_ptr] = Math.abs(a);
          break;
        case 4:
          this.ftst(a);
          break;
        case 5:
          this.fxam(a);
          break;
        default:
          this.fpu_unimpl();
      }
      break;
    case 5:
      this.push(this.constants[c]);
      break;
    case 6:
      a = this.get_st0();
      switch(c) {
        case 0:
          this.st[this.stack_ptr] = Math.pow(2, a) - 1;
          break;
        case 1:
          this.st[this.stack_ptr + 1 & 7] = this.get_sti(1) * Math.log(a) / Math.LN2;
          this.pop();
          break;
        case 2:
          this.st[this.stack_ptr] = Math.tan(a);
          this.push(1);
          break;
        case 3:
          this.st[this.stack_ptr + 1 & 7] = Math.atan2(this.get_sti(1), a);
          this.pop();
          break;
        case 4:
          this.fpu_unimpl();
          break;
        case 5:
          this.st[this.stack_ptr] = a % this.get_sti(1);
          break;
        case 6:
          this.fpu_unimpl();
          break;
        case 7:
          this.fpu_unimpl();
      }
      break;
    case 7:
      switch(a = this.get_st0(), c) {
        case 0:
          this.st[this.stack_ptr] = a % this.get_sti(1);
          break;
        case 1:
          this.st[this.stack_ptr + 1 & 7] = this.get_sti(1) * Math.log(a + 1) / Math.LN2;
          this.pop();
          break;
        case 2:
          this.st[this.stack_ptr] = Math.sqrt(a);
          break;
        case 3:
          this.st[this.stack_ptr] = Math.sin(a);
          this.push(Math.cos(a));
          break;
        case 4:
          this.st[this.stack_ptr] = this.integer_round(a);
          break;
        case 5:
          this.st[this.stack_ptr] = a * Math.pow(2, this.FPU_prototype$truncate(this.get_sti(1)));
          break;
        case 6:
          this.st[this.stack_ptr] = Math.sin(a);
          break;
        case 7:
          this.st[this.stack_ptr] = Math.cos(a);
      }
    ;
  }
};
FPU.prototype.op_D9_mem = function(a, c) {
  switch(a >> 3 & 7) {
    case 0:
      var d = this.load_m32(c);
      this.push(d);
      break;
    case 1:
      this.fpu_unimpl();
      break;
    case 2:
      this.store_m32(c, this.get_st0());
      break;
    case 3:
      this.store_m32(c, this.get_st0());
      this.pop();
      break;
    case 4:
      this.fldenv(c);
      break;
    case 5:
      this.control_word = this.cpu.safe_read16(c);
      break;
    case 6:
      this.fstenv(c);
      break;
    case 7:
      this.cpu.safe_write16(c, this.control_word);
  }
};
FPU.prototype.op_DA_reg = function(a) {
  var c = a & 7;
  switch(a >> 3 & 7) {
    case 0:
      this.cpu.test_b() && (this.st[this.stack_ptr] = this.get_sti(c), this.stack_empty &= ~(1 << this.stack_ptr));
      break;
    case 1:
      this.cpu.test_z() && (this.st[this.stack_ptr] = this.get_sti(c), this.stack_empty &= ~(1 << this.stack_ptr));
      break;
    case 2:
      this.cpu.test_be() && (this.st[this.stack_ptr] = this.get_sti(c), this.stack_empty &= ~(1 << this.stack_ptr));
      break;
    case 3:
      this.cpu.test_p() && (this.st[this.stack_ptr] = this.get_sti(c), this.stack_empty &= ~(1 << this.stack_ptr));
      break;
    case 5:
      1 === c ? (this.fucom(this.get_sti(1)), this.pop(), this.pop()) : this.fpu_unimpl();
      break;
    default:
      this.fpu_unimpl();
  }
};
FPU.prototype.op_DA_mem = function(a, c) {
  var d = a >> 3 & 7, e = this.cpu.safe_read32s(c), f = this.get_st0();
  switch(d) {
    case 0:
      this.st[this.stack_ptr] = f + e;
      break;
    case 1:
      this.st[this.stack_ptr] = f * e;
      break;
    case 2:
      this.fcom(e);
      break;
    case 3:
      this.fcom(e);
      this.pop();
      break;
    case 4:
      this.st[this.stack_ptr] = f - e;
      break;
    case 5:
      this.st[this.stack_ptr] = e - f;
      break;
    case 6:
      this.st[this.stack_ptr] = f / e;
      break;
    case 7:
      this.st[this.stack_ptr] = e / f;
  }
};
FPU.prototype.op_DB_reg = function(a) {
  var c = a & 7;
  switch(a >> 3 & 7) {
    case 0:
      this.cpu.test_b() || (this.st[this.stack_ptr] = this.get_sti(c), this.stack_empty &= ~(1 << this.stack_ptr));
      break;
    case 1:
      this.cpu.test_z() || (this.st[this.stack_ptr] = this.get_sti(c), this.stack_empty &= ~(1 << this.stack_ptr));
      break;
    case 2:
      this.cpu.test_be() || (this.st[this.stack_ptr] = this.get_sti(c), this.stack_empty &= ~(1 << this.stack_ptr));
      break;
    case 3:
      this.cpu.test_p() || (this.st[this.stack_ptr] = this.get_sti(c), this.stack_empty &= ~(1 << this.stack_ptr));
      break;
    case 4:
      227 === a ? this.finit() : 228 !== a && 225 !== a && (226 === a ? this.status_word = 0 : this.fpu_unimpl());
      break;
    case 5:
      this.fucomi(this.get_sti(c));
      break;
    case 6:
      this.fcomi(this.get_sti(c));
      break;
    default:
      this.fpu_unimpl();
  }
};
FPU.prototype.op_DB_mem = function(a, c) {
  switch(a >> 3 & 7) {
    case 0:
      var d = this.cpu.safe_read32s(c);
      this.push(d);
      break;
    case 2:
      d = this.integer_round(this.get_st0());
      2147483647 >= d && -2147483648 <= d ? this.cpu.safe_write32(c, d) : (this.invalid_arithmatic(), this.cpu.safe_write32(c, -2147483648));
      break;
    case 3:
      d = this.integer_round(this.get_st0());
      2147483647 >= d && -2147483648 <= d ? this.cpu.safe_write32(c, d) : (this.invalid_arithmatic(), this.cpu.safe_write32(c, -2147483648));
      this.pop();
      break;
    case 5:
      this.push(this.load_m80(c));
      break;
    case 7:
      this.cpu.writable_or_pagefault(c, 10);
      this.store_m80(c, 0);
      this.pop();
      break;
    default:
      this.fpu_unimpl();
  }
};
FPU.prototype.op_DC_reg = function(a) {
  var c = a >> 3 & 7, d = a & 7;
  a = this.stack_ptr + d & 7;
  var d = this.get_sti(d), e = this.get_st0();
  switch(c) {
    case 0:
      this.st[a] = d + e;
      break;
    case 1:
      this.st[a] = d * e;
      break;
    case 2:
      this.fcom(d);
      break;
    case 3:
      this.fcom(d);
      this.pop();
      break;
    case 4:
      this.st[a] = e - d;
      break;
    case 5:
      this.st[a] = d - e;
      break;
    case 6:
      this.st[a] = e / d;
      break;
    case 7:
      this.st[a] = d / e;
  }
};
FPU.prototype.op_DC_mem = function(a, c) {
  var d = a >> 3 & 7, e = this.load_m64(c), f = this.get_st0();
  switch(d) {
    case 0:
      this.st[this.stack_ptr] = f + e;
      break;
    case 1:
      this.st[this.stack_ptr] = f * e;
      break;
    case 2:
      this.fcom(e);
      break;
    case 3:
      this.fcom(e);
      this.pop();
      break;
    case 4:
      this.st[this.stack_ptr] = f - e;
      break;
    case 5:
      this.st[this.stack_ptr] = e - f;
      break;
    case 6:
      this.st[this.stack_ptr] = f / e;
      break;
    case 7:
      this.st[this.stack_ptr] = e / f;
  }
};
FPU.prototype.op_DD_reg = function(a) {
  var c = a & 7;
  switch(a >> 3 & 7) {
    case 0:
      this.stack_empty |= 1 << (this.stack_ptr + c & 7);
      break;
    case 2:
      this.st[this.stack_ptr + c & 7] = this.get_st0();
      break;
    case 3:
      0 !== c && (this.st[this.stack_ptr + c & 7] = this.get_st0());
      this.pop();
      break;
    case 4:
      this.fucom(this.get_sti(c));
      break;
    case 5:
      this.fucom(this.get_sti(c));
      this.pop();
      break;
    default:
      this.fpu_unimpl();
  }
};
FPU.prototype.op_DD_mem = function(a, c) {
  switch(a >> 3 & 7) {
    case 0:
      var d = this.load_m64(c);
      this.push(d);
      break;
    case 1:
      this.fpu_unimpl();
      break;
    case 2:
      this.store_m64(c);
      break;
    case 3:
      this.store_m64(c);
      this.pop();
      break;
    case 4:
      this.frstor(c);
      break;
    case 5:
      this.fpu_unimpl();
      break;
    case 6:
      this.fsave(c);
      break;
    case 7:
      this.cpu.safe_write16(c, this.load_status_word());
  }
};
FPU.prototype.op_DE_reg = function(a) {
  var c = a >> 3 & 7;
  a = a & 7;
  var d = this.stack_ptr + a & 7, e = this.get_sti(a), f = this.get_st0();
  switch(c) {
    case 0:
      this.st[d] = e + f;
      break;
    case 1:
      this.st[d] = e * f;
      break;
    case 2:
      this.fcom(e);
      break;
    case 3:
      1 === a ? (this.fcom(this.st[d]), this.pop()) : this.fpu_unimpl();
      break;
    case 4:
      this.st[d] = f - e;
      break;
    case 5:
      this.st[d] = e - f;
      break;
    case 6:
      this.st[d] = f / e;
      break;
    case 7:
      this.st[d] = e / f;
  }
  this.pop();
};
FPU.prototype.op_DE_mem = function(a, c) {
  var d = a >> 3 & 7, e = this.cpu.safe_read16(c) << 16 >> 16, f = this.get_st0();
  switch(d) {
    case 0:
      this.st[this.stack_ptr] = f + e;
      break;
    case 1:
      this.st[this.stack_ptr] = f * e;
      break;
    case 2:
      this.fcom(e);
      break;
    case 3:
      this.fcom(e);
      this.pop();
      break;
    case 4:
      this.st[this.stack_ptr] = f - e;
      break;
    case 5:
      this.st[this.stack_ptr] = e - f;
      break;
    case 6:
      this.st[this.stack_ptr] = f / e;
      break;
    case 7:
      this.st[this.stack_ptr] = e / f;
  }
};
FPU.prototype.op_DF_reg = function(a) {
  var c = a & 7;
  switch(a >> 3 & 7) {
    case 4:
      224 === a ? this.cpu.reg16[0] = this.load_status_word() : this.fpu_unimpl();
      break;
    case 5:
      this.fucomi(this.get_sti(c));
      this.pop();
      break;
    case 6:
      this.fcomi(this.get_sti(c));
      this.pop();
      break;
    default:
      this.fpu_unimpl();
  }
};
FPU.prototype.op_DF_mem = function(a, c) {
  switch(a >> 3 & 7) {
    case 0:
      var d = this.cpu.safe_read16(c) << 16 >> 16;
      this.push(d);
      break;
    case 1:
      this.fpu_unimpl();
      break;
    case 2:
      d = this.integer_round(this.get_st0());
      32767 >= d && -32768 <= d ? this.cpu.safe_write16(c, d) : (this.invalid_arithmatic(), this.cpu.safe_write16(c, 32768));
      break;
    case 3:
      d = this.integer_round(this.get_st0());
      32767 >= d && -32768 <= d ? this.cpu.safe_write16(c, d) : (this.invalid_arithmatic(), this.cpu.safe_write16(c, 32768));
      this.pop();
      break;
    case 4:
      this.fpu_unimpl();
      break;
    case 5:
      var e = this.cpu.safe_read32s(c) >>> 0, d = this.cpu.safe_read32s(c + 4) >>> 0, e = e + 4294967296 * d;
      d >> 31 && (e -= 1.8446744073709552E19);
      this.push(e);
      break;
    case 6:
      this.fpu_unimpl();
      break;
    case 7:
      this.cpu.writable_or_pagefault(c, 8);
      var d = this.integer_round(this.get_st0()), f;
      0x7fffffffffffffff > d && -9223372036854775808 <= d ? (e = d | 0, f = d / 4294967296 | 0, 0 === f && 0 > d && (f = -1)) : (e = 0, f = -2147483648, this.invalid_arithmatic());
      this.cpu.safe_write32(c, e);
      this.cpu.safe_write32(c + 4, f);
      this.pop();
  }
};
function IDEDevice(a, c, d, e) {
  0 === e ? (this.ata_port = 496, this.IDEDevice$irq = 14, this.pci_id = 240) : (this.ata_port = 496, this.IDEDevice$irq = 14, this.pci_id = 248);
  this.ata_port_high = this.ata_port | 516;
  this.pic = a.devices.pic;
  this.memory = a.memory;
  this.buffer = c;
  this.sector_size = d ? 2048 : 512;
  this.is_atapi = d;
  this.cylinder_count = this.IDEDevice$sectors_per_track = this.head_count = this.sector_count = 0;
  this.buffer && (this.sector_count = this.buffer.byteLength / this.sector_size, this.sector_count !== (this.sector_count | 0) && (this.sector_count = Math.ceil(this.sector_count)), d ? (this.head_count = 1, this.IDEDevice$sectors_per_track = 0) : (this.head_count = 255, this.IDEDevice$sectors_per_track = 63), this.cylinder_count = this.sector_count / (this.head_count + 1) / (this.IDEDevice$sectors_per_track + 1), this.cylinder_count !== (this.cylinder_count | 0) && (this.cylinder_count = Math.ceil(this.cylinder_count)));
  this.stats = {sectors_read:0, sectors_written:0, bytes_read:0, bytes_written:0, loading:!1};
  this.pci_space = [134, 128, 32, 58, 5, 0, 160, 2, 0, 143, 1, 1, 0, 0, 0, 0, this.ata_port & 255 | 1, this.ata_port >> 8, 0, 0, this.ata_port_high & 255 | 1, this.ata_port_high >> 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 192, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 67, 16, 212, 130, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, this.IDEDevice$irq, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  this.pci_bars = [{size:8}, {size:4}, !1, !1, {size:16}];
  a.devices.pci.register_device(this);
  a.io.register_read(this.ata_port | 7, this, this.read_status);
  a.io.register_read(this.ata_port_high | 2, this, this.read_status);
  a.io.register_write(this.ata_port | 7, this, this.write_control);
  a.io.register_write(this.ata_port_high | 2, this, this.write_control);
  this.device_control = 2;
  this.data_pointer = 0;
  this.pio_data = new Uint8Array(0);
  this.drive_head = this.head = this.cylinder_high = this.cylinder_low = this.lba_count = this.sector = this.bytecount = this.is_lba = 0;
  this.status = 80;
  this.sectors_per_drq = 1;
  this.data_port_current = this.data_port_count = this.write_dest = 0;
  this.data_port_buffer = new Uint8Array(0);
  this.data_port_callback = 0;
  this.next_status = -1;
  this.dma_status = this.prdt_addr = 0;
  a.io.register_read(this.ata_port | 0, this, this.read_data_port8, this.read_data_port16, this.read_data_port32);
  a.io.register_read(this.ata_port | 1, this, this.read_lba_port);
  a.io.register_read(this.ata_port | 2, this, this.read_bytecount_port);
  a.io.register_read(this.ata_port | 3, this, this.read_sector_port);
  a.io.register_read(this.ata_port | 4, this, function() {
    return this.cylinder_low & 255;
  });
  a.io.register_read(this.ata_port | 5, this, function() {
    return this.cylinder_high & 255;
  });
  a.io.register_read(this.ata_port | 6, this, function() {
    return this.drive_head;
  });
  a.io.register_write(this.ata_port | 0, this, this.write_data_port8, this.write_data_port16, this.write_data_port32);
  a.io.register_write(this.ata_port | 1, this, this.write_lba_port);
  a.io.register_write(this.ata_port | 2, this, this.write_bytecount_port);
  a.io.register_write(this.ata_port | 3, this, this.write_sector_port);
  a.io.register_write(this.ata_port | 4, this, function(a) {
    this.cylinder_low = (this.cylinder_low << 8 | a) & 65535;
  });
  a.io.register_write(this.ata_port | 5, this, function(a) {
    this.cylinder_high = (this.cylinder_high << 8 | a) & 65535;
  });
  a.io.register_write(this.ata_port | 6, this, function(a) {
    a & 16 || (this.drive_head = a, this.is_lba = a >> 6 & 1, this.head = a & 15);
  });
  a.io.register_write(this.ata_port | 7, this, this.ata_command);
  a.io.register_read(49156, this, void 0, void 0, this.dma_read_addr);
  a.io.register_write(49156, this, void 0, void 0, this.dma_set_addr);
  a.io.register_read(49152, this, this.dma_read_command8, void 0, this.dma_read_command);
  a.io.register_write(49152, this, this.dma_write_command8, void 0, this.dma_write_command);
  a.io.register_read(49154, this, this.dma_read_status);
  a.io.register_write(49154, this, this.dma_write_status);
  this._state_skip = [this.memory, this.pic, this.stats, this.buffer];
}
IDEDevice.prototype.do_callback = function() {
  switch(this.data_port_callback) {
    case 1:
      this.do_write();
      break;
    case 2:
      this.atapi_handle();
  }
};
IDEDevice.prototype.push_irq = function() {
  0 === (this.device_control & 2) && (this.dma_status |= 4, this.pic.push_irq(this.IDEDevice$irq));
};
IDEDevice.prototype.ata_command = function(a) {
  switch(a) {
    case 0:
      this.push_irq();
      this.status = 80;
      break;
    case 8:
      this.data_pointer = 0;
      this.pio_data = new Uint8Array(0);
      this.status = 80;
      this.push_irq();
      break;
    case 16:
      this.push_irq();
      break;
    case 39:
      this.push_irq();
      this.pio_data = new Uint8Array([0, 0, 0, 0, this.buffer.byteLength & 255, this.buffer.byteLength >> 8 & 255, this.buffer.byteLength >> 16 & 255, this.buffer.byteLength >> 24 & 255, 0, 0, 0, 0]);
      this.status = 88;
      break;
    case 32:
    ;
    case 41:
    ;
    case 36:
    ;
    case 196:
      this.ata_read_sectors(a);
      break;
    case 48:
    ;
    case 52:
    ;
    case 57:
      this.ata_write(a);
      break;
    case 144:
      this.push_irq();
      this.lba_count = 257;
      this.status = 80;
      break;
    case 145:
      this.push_irq();
      break;
    case 160:
      this.is_atapi && (this.status = 88, this.allocate_in_buffer(12), this.data_port_callback = 2, this.bytecount = 1, this.push_irq());
      break;
    case 161:
      this.is_atapi ? (this.create_identify_packet(), this.status = 88) : this.status = 80;
      this.push_irq();
      break;
    case 198:
      this.sectors_per_drq = this.bytecount;
      this.push_irq();
      break;
    case 200:
      this.ata_read_sectors_dma();
      break;
    case 202:
      this.ata_write_dma();
      break;
    case 225:
      this.push_irq();
      break;
    case 236:
      if (this.is_atapi) {
        break;
      }
      this.create_identify_packet();
      this.status = 88;
      this.push_irq();
      break;
    case 234:
      this.push_irq();
      break;
    case 239:
      this.push_irq();
      break;
    default:
      this.lba_count = 4;
  }
};
IDEDevice.prototype.atapi_handle = function() {
  this.bytecount = 2;
  switch(this.data_port_buffer[0]) {
    case 0:
      this.status = 64;
      this.cylinder_low = 8;
      this.cylinder_high = 0;
      this.push_irq();
      break;
    case 3:
      this.pio_data = new Uint8Array(Math.min(this.data_port_buffer[4], 15));
      this.status = 88;
      this.pio_data[0] = 240;
      this.pio_data[7] = 8;
      this.data_pointer = 0;
      this.bytecount = 2;
      this.cylinder_low = 8;
      this.cylinder_high = 0;
      this.push_irq();
      break;
    case 18:
      this.pio_data = new Uint8Array(Math.min(this.data_port_buffer[4], 36));
      this.status = 88;
      this.pio_data.set([5, 128, 1, 49, 0, 0, 0, 0, 83, 79, 78, 89, 32, 32, 32, 32, 67, 68, 45, 82, 79, 77, 32, 67, 68, 85, 45, 49, 48, 48, 48, 32, 49, 46, 49, 97]);
      this.data_pointer = 0;
      this.bytecount = 2;
      this.push_irq();
      break;
    case 30:
      this.pio_data = new Uint8Array(0);
      this.status = 80;
      this.data_pointer = 0;
      this.bytecount = 2;
      this.push_irq();
      break;
    case 37:
      this.pio_data = new Uint8Array([this.sector_count >> 24 & 255, this.sector_count >> 16 & 255, this.sector_count >> 8 & 255, this.sector_count & 255, 0, 0, this.sector_size >> 8 & 255, this.sector_size & 255]);
      this.status = 88;
      this.data_pointer = 0;
      this.bytecount = 2;
      this.cylinder_low = 8;
      this.cylinder_high = 0;
      this.push_irq();
      break;
    case 40:
      this.lba_count & 1 ? this.atapi_read_dma(this.data_port_buffer) : this.atapi_read(this.data_port_buffer);
      break;
    case 67:
      this.pio_data = new Uint8Array(2048);
      this.pio_data[0] = 0;
      this.pio_data[1] = 10;
      this.pio_data[2] = 1;
      this.pio_data[3] = 1;
      this.status = 88;
      this.data_pointer = 0;
      this.bytecount = 2;
      this.cylinder_high = 8;
      this.cylinder_low = 0;
      this.push_irq();
      break;
    case 70:
      this.pio_data = new Uint8Array(this.data_port_buffer[8] | this.data_port_buffer[7] << 8);
      this.status = 88;
      this.data_pointer = 0;
      this.bytecount = 2;
      this.push_irq();
      break;
    case 74:
      this.pio_data = new Uint8Array(this.data_port_buffer[8] | this.data_port_buffer[7] << 8);
      this.status = 88;
      this.data_pointer = 0;
      this.bytecount = 2;
      this.push_irq();
      break;
    case 81:
      this.pio_data = new Uint8Array(0);
      this.status = 80;
      this.data_pointer = 0;
      this.bytecount = 2;
      this.push_irq();
      break;
    case 90:
      this.push_irq();
      this.status = 80;
      break;
    default:
      this.status = 80;
  }
};
IDEDevice.prototype.do_write = function() {
  this.status = 80;
  this.buffer.set(this.write_dest, this.data_port_buffer.subarray(0, this.data_port_count), function() {
    this.push_irq();
  }.bind(this));
  this.stats.sectors_written += this.data_port_count / this.sector_size | 0;
  this.stats.bytes_written += this.data_port_count;
};
IDEDevice.prototype.read_status = function() {
  var a = this.status;
  0 <= this.next_status && (this.status = this.next_status, this.next_status = -1);
  return a;
};
IDEDevice.prototype.write_control = function(a) {
  this.device_control = a;
  a & 4 && (this.is_atapi ? (this.status = 81, this.sector = this.lba_count = this.bytecount = 1, this.cylinder_low = 20, this.cylinder_high = 235) : (this.status = 81, this.sector = this.lba_count = this.bytecount = 1, this.cylinder_low = 60, this.cylinder_high = 195));
};
IDEDevice.prototype.allocate_in_buffer = function(a) {
  a > this.data_port_buffer.length && (this.data_port_buffer = new Uint8Array(a));
  this.data_port_count = a;
  this.data_port_current = 0;
};
IDEDevice.prototype.atapi_read = function(a) {
  var c = (a[7] << 8 | a[8]) * this.sector_size, d = (this.cylinder_high & 255) << 8 | this.cylinder_low & 255;
  a = (a[2] << 24 | a[3] << 16 | a[4] << 8 | a[5]) * this.sector_size;
  d || (d = 32768);
  d = Math.min(c, d);
  this.cylinder_low = d & 255;
  this.cylinder_high = d >> 8 & 255;
  a >= this.buffer.byteLength ? (this.status = 255, this.push_irq()) : (c = Math.min(c, this.buffer.byteLength - a), this.status = 128, this.stats.loading = !0, this.buffer.get(a, c, function(a) {
    this.pio_data = a;
    this.status = 88;
    this.data_pointer = 0;
    this.push_irq();
    this.stats.loading = !1;
    this.stats.sectors_read += c / this.sector_size | 0;
    this.stats.bytes_read += c;
  }.bind(this)));
};
IDEDevice.prototype.atapi_read_dma = function(a) {
  var c = (a[7] << 8 | a[8]) * this.sector_size;
  a = (a[2] << 24 | a[3] << 16 | a[4] << 8 | a[5]) * this.sector_size;
  a >= this.buffer.byteLength ? (this.status = 255, this.push_irq()) : (c = Math.min(c, this.buffer.byteLength - a), this.status = 128, this.stats.loading = !0, this.buffer.get(a, c, function(a) {
    var e = this.prdt_addr, f = 0;
    do {
      var g = this.memory.read32s(e), k = this.memory.read16(e + 4), m = this.memory.read8(e + 7) & 128;
      k || (k = 65536);
      this.memory.write_blob(a.subarray(f, f + k), g);
      f += k;
      e += 8;
    } while (!m);
    this.status = 80;
    this.dma_status &= -4;
    this.dma_status |= 4;
    this.push_irq();
    this.stats.loading = !1;
    this.stats.sectors_read += c / this.sector_size | 0;
    this.stats.bytes_read += c;
  }.bind(this)));
};
IDEDevice.prototype.read_data_port8 = function() {
  return this.read_data();
};
IDEDevice.prototype.read_data_port16 = function() {
  return this.read_data() | this.read_data() << 8;
};
IDEDevice.prototype.read_data_port32 = function() {
  return this.read_data() | this.read_data() << 8 | this.read_data() << 16 | this.read_data() << 24;
};
IDEDevice.prototype.read_lba_port = function() {
  return this.lba_count & 255;
};
IDEDevice.prototype.read_bytecount_port = function() {
  return this.bytecount & 255;
};
IDEDevice.prototype.read_sector_port = function() {
  return this.sector & 255;
};
IDEDevice.prototype.read_data = function() {
  if (this.data_pointer < this.pio_data.length) {
    0 !== (this.data_pointer + 1) % (512 * this.sectors_per_drq) && this.data_pointer + 1 !== this.pio_data.length || this.push_irq();
    this.cylinder_low ? this.cylinder_low-- : this.cylinder_high && (this.cylinder_high--, this.cylinder_low = 255);
    if (!this.cylinder_low && !this.cylinder_high) {
      var a = this.pio_data.length - this.data_pointer - 1;
      65536 <= a ? (this.cylinder_high = 240, this.cylinder_low = 0) : (this.cylinder_high = a >> 8, this.cylinder_low = a);
    }
    this.data_pointer + 1 >= this.pio_data.length && (this.status = 80);
    return this.pio_data[this.data_pointer++];
  }
  this.data_pointer++;
  return 0;
};
IDEDevice.prototype.write_data_port8 = function(a) {
  this.data_port_current >= this.data_port_count || (this.data_port_buffer[this.data_port_current++] = a, 0 === this.data_port_current % (512 * this.sectors_per_drq) && this.push_irq(), this.data_port_current === this.data_port_count && this.do_callback());
};
IDEDevice.prototype.write_data_port16 = function(a) {
  this.write_data_port8(a & 255);
  this.write_data_port8(a >> 8 & 255);
};
IDEDevice.prototype.write_data_port32 = function(a) {
  this.write_data_port8(a & 255);
  this.write_data_port8(a >> 8 & 255);
  this.write_data_port8(a >> 16 & 255);
  this.write_data_port8(a >> 24 & 255);
};
IDEDevice.prototype.write_lba_port = function(a) {
  this.lba_count = (this.lba_count << 8 | a) & 65535;
};
IDEDevice.prototype.write_bytecount_port = function(a) {
  this.bytecount = (this.bytecount << 8 | a) & 65535;
};
IDEDevice.prototype.write_sector_port = function(a) {
  this.sector = (this.sector << 8 | a) & 65535;
};
IDEDevice.prototype.ata_read_sectors = function(a) {
  if (32 === a || 196 === a) {
    a = this.bytecount & 255;
    var c = this.is_lba ? this.get_lba28() : this.get_chs();
    0 === a && (a = 256);
  } else {
    if (36 === a || 41 === a) {
      a = this.bytecount, c = this.get_lba48(), 0 === a && (a = 65536);
    } else {
      return;
    }
  }
  var d = a * this.sector_size, c = c * this.sector_size;
  this.cylinder_low += a;
  c + d > this.buffer.byteLength ? (this.status = 255, this.push_irq()) : (this.status = 128, this.stats.loading = !0, this.buffer.get(c, d, function(a) {
    this.pio_data = a;
    this.status = 88;
    this.data_pointer = 0;
    this.push_irq();
    this.stats.loading = !1;
    this.stats.sectors_read += d / this.sector_size | 0;
    this.stats.bytes_read += d;
  }.bind(this)));
};
IDEDevice.prototype.ata_read_sectors_dma = function() {
  var a = this.bytecount & 255, c = a * this.sector_size, d = this.get_lba28() * this.sector_size;
  this.cylinder_low += a;
  d + c > this.buffer.byteLength ? (this.status = 255, this.push_irq()) : (this.status = 128, this.dma_status |= 1, this.stats.loading = !0, this.buffer.get(d, c, function(a) {
    var d = this.prdt_addr, g = 0;
    do {
      var k = this.memory.read32s(d), m = this.memory.read16(d + 4), l = this.memory.read8(d + 7) & 128;
      m || (m = 65536);
      this.memory.write_blob(a.subarray(g, g + m), k);
      g += m;
      d += 8;
    } while (!l);
    this.status = 80;
    this.dma_status &= -4;
    this.dma_status |= 4;
    this.push_irq();
    this.stats.loading = !1;
    this.stats.sectors_read += c / this.sector_size | 0;
    this.stats.bytes_read += c;
  }.bind(this)));
};
IDEDevice.prototype.ata_write = function(a) {
  if (48 === a) {
    a = this.bytecount & 255;
    var c = this.is_lba ? this.get_lba28() : this.get_chs();
    0 === a && (a = 256);
  } else {
    if (52 === a || 57 === a) {
      a = this.bytecount, c = this.get_lba48(), 0 === a && (a = 65536);
    } else {
      return;
    }
  }
  var d = a * this.sector_size, c = c * this.sector_size;
  this.cylinder_low += a;
  c + d > this.buffer.byteLength ? this.status = 255 : (this.status = 80, this.next_status = 88, this.allocate_in_buffer(d), this.write_dest = c, this.data_port_callback = 1);
  this.push_irq();
};
IDEDevice.prototype.ata_write_dma = function() {
  var a = this.bytecount & 255, c = a * this.sector_size, d = this.get_lba28() * this.sector_size;
  this.cylinder_low += a;
  if (d + c > this.buffer.byteLength) {
    this.status = 255, this.push_irq();
  } else {
    this.status = 128;
    this.dma_status |= 1;
    var a = this.prdt_addr, e = 0, f = 0, g = 0;
    do {
      var k = this.memory.read32s(a), m = this.memory.read16(a + 4), l = this.memory.read8(a + 7) & 128;
      m || (m = 65536);
      this.buffer.set(d + g, this.memory.mem8.subarray(k, k + m), function() {
        f++;
        f === e && (this.status = 80, this.push_irq(), this.dma_status &= -4, this.dma_status |= 4);
      }.bind(this));
      g += m;
      a += 8;
      e++;
    } while (!l);
    f === e && (this.status = 80, this.push_irq(), this.dma_status &= -4, this.dma_status |= 4);
    this.stats.sectors_written += c / this.sector_size | 0;
    this.stats.bytes_written += c;
  }
};
IDEDevice.prototype.get_chs = function() {
  return((this.cylinder_low & 255 | this.cylinder_high << 8 & 65280) * this.head_count + this.head) * this.IDEDevice$sectors_per_track + (this.sector & 255) - 1;
};
IDEDevice.prototype.get_lba28 = function() {
  return this.sector & 255 | this.cylinder_low << 8 & 65280 | this.cylinder_high << 16 & 16711680;
};
IDEDevice.prototype.get_lba48 = function() {
  return(this.sector & 255 | this.cylinder_low << 8 & 65280 | this.cylinder_high << 16 & 16711680 | this.sector >> 8 << 24 & 4278190080) >>> 0;
};
IDEDevice.prototype.create_identify_packet = function() {
  this.data_pointer = 0;
  this.drive_head & 16 ? this.pio_data = new Uint8Array(0) : (this.pio_data = new Uint8Array([64, this.is_atapi ? 133 : 0, this.cylinder_count, this.cylinder_count >> 8, 0, 0, this.head_count, this.head_count >> 8, 0, 0, 0, 0, this.IDEDevice$sectors_per_track, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 
  32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 255, 0, 1, 0, 0, 3, 0, 0, 0, 2, 0, 2, 7, 0, this.cylinder_count, this.cylinder_count >> 8, this.head_count, this.head_count >> 8, this.IDEDevice$sectors_per_track, 0, this.sector_count & 255, this.sector_count >> 8 & 255, this.sector_count >> 16 & 255, this.sector_count >> 24 & 255, 0, 0, this.sector_count & 255, this.sector_count >> 8 & 255, this.sector_count >> 16 & 255, this.sector_count >> 24 & 255, 0, 0, 0, 4, 0, 0, 30, 0, 30, 0, 30, 0, 30, 0, 0, 0, 
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 126, 0, 0, 0, 0, 0, 0, 116, 0, 64, 0, 64, 0, 116, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 96, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, this.sector_count & 255, this.sector_count >> 8 & 255, this.sector_count >> 16 & 255, this.sector_count >> 24 & 255]), 16383 < this.cylinder_count && (this.pio_data[2] = this.pio_data[108] = 255, this.pio_data[3] = this.pio_data[109] = 63));
};
IDEDevice.prototype.dma_read_addr = function() {
  return this.prdt_addr;
};
IDEDevice.prototype.dma_set_addr = function(a) {
  this.prdt_addr = a;
};
IDEDevice.prototype.dma_read_status = function() {
  return this.dma_status;
};
IDEDevice.prototype.dma_write_status = function(a) {
  this.dma_status &= ~a;
};
IDEDevice.prototype.dma_read_command = function() {
  return 1 | this.dma_status << 16;
};
IDEDevice.prototype.dma_read_command8 = function() {
  return 1;
};
IDEDevice.prototype.dma_write_command = function(a) {
  a & 1 && this.push_irq();
  this.dma_write_status(a >> 16 & 255);
};
IDEDevice.prototype.dma_write_command8 = function(a) {
  a & 1 && this.push_irq();
};
function PCI(a) {
  function c(a) {
    var c = d[2] << 8 | d[1], e = d[0] & 252, f = m[c], c = l[c];
    f && 3 === a && 16 <= e && 40 > e && (a = e - 16 >> 2, c = c.pci_bars, a < c.length && c[a] || (f[e >> 2] = 0));
  }
  a = a.io;
  var d = new Uint8Array(4), e = new Uint8Array(4), f = new Uint8Array(4);
  new Int32Array(d.buffer);
  var g = new Int32Array(e.buffer), k = new Int32Array(f.buffer), m = Array(65536), l = Array(65536);
  a.register_write_consecutive(3324, this, function() {
    c(0);
  }, function() {
    c(1);
  }, function() {
    c(2);
  }, function() {
    c(3);
  });
  a.register_read_consecutive(3324, this, function() {
    return e[0];
  }, function() {
    return e[1];
  }, function() {
    return e[2];
  }, function() {
    return e[3];
  });
  a.register_read_consecutive(3320, this, function() {
    return f[0];
  }, function() {
    return f[1];
  }, function() {
    return f[2];
  }, function() {
    return f[3];
  });
  a.register_write_consecutive(3320, this, function(a) {
    d[0] = a;
  }, function(a) {
    d[1] = a;
  }, function(a) {
    d[2] = a;
  }, function(a) {
    d[3] = a;
    a = d[0] & 252;
    var c = m[d[2] << 8 | d[1]];
    void 0 !== c ? (k[0] = -2147483648, g[0] = a < c.byteLength ? c[a >> 2] : -1) : (g[0] = -1, k[0] = 0);
  });
  this.register_device = function(a) {
    var c = a.pci_id;
    m[c] = new Int32Array((new Uint8Array(a.pci_space)).buffer);
    l[c] = a;
  };
  this.register_device({pci_id:0, pci_space:[134, 128, 55, 18, 0, 0, 0, 0, 2, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], pci_bars:[]});
  this.register_device({pci_id:8, pci_space:[134, 128, 0, 112, 7, 0, 0, 2, 0, 0, 1, 6, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], pci_bars:[]});
}
;function FloppyController(a, c, d) {
  this.io = a.io;
  this.pic = a.devices.pic;
  this.dma = a.devices.dma;
  this.bytes_expecting = 0;
  this.receiving_command = new Uint8Array(10);
  this.receiving_index = 0;
  this.next_command = null;
  this.response_data = new Uint8Array(10);
  this.floppy_size = this.response_length = this.response_index = 0;
  this.fda_image = c;
  this.fdb_image = d;
  this.last_cylinder = 0;
  this._state_skip = [this.io, this.pic, this.dma];
  this.fdb_image && this._state_skip.push(this.fdb_image);
  if (c) {
    this._state_skip.push(this.fda_image);
    this.floppy_size = c.byteLength;
    if ((a = {160:{type:1, tracks:40, sectors:8, heads:1}, 180:{type:1, tracks:40, sectors:9, heads:1}, 200:{type:1, tracks:40, sectors:10, heads:1}, 320:{type:1, tracks:40, sectors:8, heads:2}, 360:{type:1, tracks:40, sectors:9, heads:2}, 400:{type:1, tracks:40, sectors:10, heads:2}, 720:{type:3, tracks:80, sectors:9, heads:2}, 1200:{type:2, tracks:80, sectors:15, heads:2}, 1440:{type:4, tracks:80, sectors:18, heads:2}, 1722:{type:5, tracks:82, sectors:21, heads:2}, 2880:{type:5, tracks:80, sectors:36, 
    heads:2}}[this.floppy_size >> 10]) && 0 === (this.floppy_size & 1023)) {
      this.type = a.type, c = a.sectors, a = a.heads;
    } else {
      throw "Unknown floppy size: " + h(c.byteLength);
    }
    this.FloppyController$sectors_per_track = c;
    this.number_of_heads = a;
    this.io.register_read(1008, this, this.port3F0_read);
    this.io.register_read(1010, this, this.port3F2_read);
    this.io.register_read(1012, this, this.port3F4_read);
    this.io.register_read(1013, this, this.port3F5_read);
    this.io.register_read(1015, this, this.port3F7_read);
    this.io.register_write(1010, this, this.port3F2_write);
    this.io.register_write(1013, this, this.port3F5_write);
  } else {
    this.type = 4, this.io.register_read(1012, this, function() {
      return 255;
    });
  }
}
FloppyController.prototype.port3F0_read = function() {
  return 0;
};
FloppyController.prototype.port3F4_read = function() {
  var a = 128;
  this.response_index < this.response_length && (a |= 80);
  0 === (dor & 8) && (a |= 32);
  return a;
};
FloppyController.prototype.port3F7_read = function() {
  return 0;
};
FloppyController.prototype.port3F5_read = function() {
  return this.response_index < this.response_length ? this.response_data[this.response_index++] : 255;
};
FloppyController.prototype.port3F5_write = function(a) {
  if (0 < this.bytes_expecting) {
    this.receiving_command[this.receiving_index++] = a, this.bytes_expecting--, 0 === this.bytes_expecting && this.next_command.call(this, this.receiving_command);
  } else {
    switch(a) {
      case 3:
        this.next_command = this.fix_drive_data;
        this.bytes_expecting = 2;
        break;
      case 4:
        this.next_command = this.check_drive_status;
        this.bytes_expecting = 1;
        break;
      case 5:
      ;
      case 197:
        this.next_command = function(a) {
          this.do_sector(!0, a);
        };
        this.bytes_expecting = 8;
        break;
      case 230:
        this.next_command = function(a) {
          this.do_sector(!1, a);
        };
        this.bytes_expecting = 8;
        break;
      case 7:
        this.next_command = this.calibrate;
        this.bytes_expecting = 1;
        break;
      case 8:
        this.check_interrupt_status();
        break;
      case 74:
        this.next_command = this.read_sector_id;
        this.bytes_expecting = 1;
        break;
      case 15:
        this.bytes_expecting = 2;
        this.next_command = this.FloppyController_prototype$seek;
        break;
      case 14:
        this.response_data[0] = 128, this.response_index = 0, this.response_length = 1, this.bytes_expecting = 0;
    }
    this.receiving_index = 0;
  }
};
var dor = 0;
FloppyController.prototype.port3F2_read = function() {
  return dor;
};
FloppyController.prototype.port3F2_write = function(a) {
  4 === (a & 4) && 0 === (dor & 4) && this.pic.push_irq(6);
  dor = a;
};
FloppyController.prototype.check_drive_status = function() {
  this.response_index = 0;
  this.response_length = 1;
  this.response_data[0] = 32;
};
FloppyController.prototype.FloppyController_prototype$seek = function(a) {
  this.last_cylinder = a[1];
  dor & 8 && this.pic.push_irq(6);
};
FloppyController.prototype.calibrate = function() {
  dor & 8 && this.pic.push_irq(6);
};
FloppyController.prototype.check_interrupt_status = function() {
  this.response_index = 0;
  this.response_length = 2;
  this.response_data[0] = 32;
  this.response_data[1] = this.last_cylinder;
};
FloppyController.prototype.do_sector = function(a, c) {
  var d = c[2], e = c[1], f = c[3], g = 128 << c[4], k = c[5] - c[3] + 1, m = ((d + this.number_of_heads * e) * this.FloppyController$sectors_per_track + f - 1) * g;
  a ? this.dma.do_write(this.fda_image, m, k * g, 2, this.done.bind(this, c, e, d, f)) : this.dma.do_read(this.fda_image, m, this.done.bind(this, c, e, d, f));
};
FloppyController.prototype.done = function(a, c, d, e, f) {
  f || (e++, e > this.FloppyController$sectors_per_track && (e = 1, d++, d >= this.number_of_heads && (d = 0, a++)), this.last_cylinder = a, this.response_index = 0, this.response_length = 7, this.response_data[0] = d << 2 | 32, this.response_data[1] = 0, this.response_data[2] = 0, this.response_data[3] = a, this.response_data[4] = d, this.response_data[5] = e, this.response_data[6] = c[4], dor & 8 && this.pic.push_irq(6));
};
FloppyController.prototype.fix_drive_data = function() {
};
FloppyController.prototype.read_sector_id = function() {
  this.response_index = 0;
  this.response_length = 7;
  this.response_data[0] = 0;
  this.response_data[1] = 0;
  this.response_data[2] = 0;
  this.response_data[3] = 0;
  this.response_data[4] = 0;
  this.response_data[5] = 0;
  this.response_data[6] = 0;
  dor & 8 && this.pic.push_irq(6);
};
function Memory(a) {
  this.size = a;
  this.memory_map_registered = new Uint8Array(262144);
  this.memory_map_read8 = [];
  this.memory_map_write8 = [];
  this.memory_map_read32 = [];
  this.memory_map_write32 = [];
  this.buffer = new ArrayBuffer(a);
  this._state_restore();
}
Memory.prototype._state_restore = function() {
  this.mem8 = new Uint8Array(this.buffer);
  this.mem16 = new Uint16Array(this.buffer);
  this.mem32s = new Int32Array(this.buffer);
  this._state_skip = [this.mem8, this.mem16, this.mem32s, this.memory_map_registered, this.memory_map_read8, this.memory_map_read32, this.memory_map_write8, this.memory_map_write32];
};
Memory.prototype.mmap_read8 = function(a) {
  return this.memory_map_read8[a >>> 14](a);
};
Memory.prototype.mmap_write8 = function(a, c) {
  this.memory_map_write8[a >>> 14](a, c);
};
Memory.prototype.mmap_read16 = function(a) {
  var c = this.memory_map_read8[a >>> 14];
  return c(a) | c(a + 1) << 8;
};
Memory.prototype.mmap_write16 = function(a, c) {
  var d = this.memory_map_write8[a >>> 14];
  d(a, c & 255);
  d(a + 1, c >> 8 & 255);
};
Memory.prototype.mmap_read32 = function(a) {
  return this.memory_map_read32[a >>> 14](a);
};
Memory.prototype.mmap_write32 = function(a, c) {
  this.memory_map_write32[a >>> 14](a, c);
};
Memory.prototype.read8 = function(a) {
  return this.memory_map_registered[a >>> 14] ? this.mmap_read8(a) : this.mem8[a];
};
Memory.prototype.read16 = function(a) {
  return this.memory_map_registered[a >>> 14] ? this.mmap_read16(a) : this.mem8[a] | this.mem8[a + 1] << 8;
};
Memory.prototype.read_aligned16 = function(a) {
  return this.memory_map_registered[a >>> 13] ? this.mmap_read16(a << 1) : this.mem16[a];
};
Memory.prototype.read32s = function(a) {
  return this.memory_map_registered[a >>> 14] ? this.mmap_read32(a) : this.mem8[a] | this.mem8[a + 1] << 8 | this.mem8[a + 2] << 16 | this.mem8[a + 3] << 24;
};
Memory.prototype.read_aligned32 = function(a) {
  return this.memory_map_registered[a >>> 12] ? this.mmap_read32(a << 2) : this.mem32s[a];
};
Memory.prototype.write8 = function(a, c) {
  this.memory_map_registered[a >>> 14] ? this.mmap_write8(a, c) : this.mem8[a] = c;
};
Memory.prototype.write16 = function(a, c) {
  this.memory_map_registered[a >>> 14] ? this.mmap_write16(a, c) : (this.mem8[a] = c, this.mem8[a + 1] = c >> 8);
};
Memory.prototype.write_aligned16 = function(a, c) {
  this.memory_map_registered[a >>> 13] ? this.mmap_write16(a << 1, c) : this.mem16[a] = c;
};
Memory.prototype.write32 = function(a, c) {
  this.memory_map_registered[a >>> 14] ? this.mmap_write32(a, c) : (this.mem8[a] = c, this.mem8[a + 1] = c >> 8, this.mem8[a + 2] = c >> 16, this.mem8[a + 3] = c >> 24);
};
Memory.prototype.write_aligned32 = function(a, c) {
  this.memory_map_registered[a >>> 12] ? this.mmap_write32(a << 2, c) : this.mem32s[a] = c;
};
Memory.prototype.write_blob = function(a, c) {
  this.mem8.set(a, c);
};
function DMA(a) {
  this.memory = a.memory;
  this.channels = [{address:0, count:0}, {address:0, count:0}, {address:0, count:0}, {address:0, count:0}];
  this.lsb_msb_flipflop = 0;
  a = a.io;
  a.register_write(4, this, this.port_write.bind(this, 4));
  a.register_write(5, this, this.port_write.bind(this, 5));
  a.register_write(10, this, this.portA_write);
  a.register_write(11, this, this.portB_write);
  a.register_write(12, this, this.portC_write);
  a.register_write(129, this, this.port81_write);
  this._state_skip = [this.memory];
}
DMA.prototype.port_write = function(a, c) {
  if (8 > a) {
    var d = a >> 1;
    a & 1 ? this.channels[d].count = this.flipflop_get(this.channels[d].count, c) : this.channels[d].address = this.flipflop_get(this.channels[d].address, c);
  }
};
DMA.prototype.portA_write = function() {
};
DMA.prototype.portB_write = function() {
};
DMA.prototype.portC_write = function() {
  this.lsb_msb_flipflop = 0;
};
DMA.prototype.port81_write = function(a) {
  this.channels[2].address = this.channels[2].address & 65535 | a << 16;
};
DMA.prototype.do_read = function(a, c, d) {
  var e = this.channels[2].count + 1, f = this.channels[2].address;
  if (c + e > a.byteLength) {
    d(!0);
  } else {
    var g = this.memory;
    this.channels[2].address += e;
    a.get(c, e, function(a) {
      g.write_blob(a, f);
      d(!1);
    });
  }
};
DMA.prototype.do_write = function(a, c, d, e, f) {
  d = this.channels[e].count;
  var g = this.channels[e].address;
  c + d > a.byteLength ? f(!0) : (this.channels[e].address += d, a.set(c, new Uint8Array(this.memory.buffer, g, d + 1), function() {
    f(!1);
  }));
};
DMA.prototype.flipflop_get = function(a, c) {
  return(this.lsb_msb_flipflop ^= 1) ? a & -256 | c : a & -65281 | c << 8;
};
function PIT(a) {
  this.pic = a.devices.pic;
  this.PIT$next_tick = Date.now();
  this.counter_next_low = new Uint8Array(4);
  this.counter_enabled = new Uint8Array(4);
  this.counter_mode = new Uint8Array(4);
  this.counter_read_mode = new Uint8Array(4);
  this.counter_latch = new Uint8Array(4);
  this.counter_latch_value = new Uint16Array(3);
  this.counter_reload = new Uint16Array(3);
  this.counter_current = new Uint16Array(3);
  this.counter2_out = 0;
  a.io.register_read(97, this, function() {
    return(66.66666666666667 * v86.microtick() & 1) << 4 | this.counter2_out << 5;
  });
  a.io.register_read(64, this, function() {
    return this.counter_read(0);
  });
  a.io.register_read(65, this, function() {
    return this.counter_read(1);
  });
  a.io.register_read(66, this, function() {
    return this.counter_read(2);
  });
  a.io.register_write(64, this, function(a) {
    this.counter_write(0, a);
  });
  a.io.register_write(65, this, function(a) {
    this.counter_write(1, a);
  });
  a.io.register_write(66, this, function(a) {
    this.counter_write(2, a);
  });
  a.io.register_write(67, this, this.port43_write);
  this._state_skip = [this.pic];
}
PIT.prototype.timer = function(a, c) {
  var d, e, f = 1193.1816666 * (a - this.PIT$next_tick) >>> 0;
  if (f) {
    this.PIT$next_tick += f / 1193.1816666;
    if (!c && this.counter_enabled[0] && (d = this.counter_current[0] -= f, 0 >= d)) {
      if (this.pic.push_irq(0), e = this.counter_mode[0], 0 === e) {
        this.counter_enabled[0] = 0, this.counter_current[0] = 0;
      } else {
        if (3 === e || 2 === e) {
          this.counter_current[0] = this.counter_reload[0] + d % this.counter_reload[0];
        }
      }
    }
    this.counter_enabled[2] && (d = this.counter_current[2] -= f, 0 >= d && (e = this.counter_mode[2], 0 === e ? (this.counter2_out = 1, this.counter_enabled[2] = 0, this.counter_current[2] = 0) : 2 === e ? (this.counter2_out = 1, this.counter_current[2] = this.counter_reload[2] + d % this.counter_reload[2]) : 3 === e && (this.counter2_out ^= 1, this.counter_current[2] = this.counter_reload[2] + d % this.counter_reload[2])));
  }
};
PIT.prototype.counter_read = function(a) {
  var c = this.counter_latch[a];
  if (c) {
    return this.counter_latch[a]--, 2 === c ? this.counter_latch_value[a] & 255 : this.counter_latch_value[a] >> 8;
  }
  c = this.counter_next_low[a];
  3 === this.counter_mode[a] && (this.counter_next_low[a] ^= 1);
  return c ? this.counter_current[a] & 255 : this.counter_current[a] >> 8;
};
PIT.prototype.counter_write = function(a, c) {
  this.counter_reload[a] = this.counter_next_low[a] ? this.counter_reload[a] & -256 | c : this.counter_reload[a] & 255 | c << 8;
  3 === this.counter_read_mode[a] && this.counter_next_low[a] || (this.counter_reload[a] || (this.counter_reload[a] = 65535), this.counter_current[a] = this.counter_reload[a], this.counter_enabled[a] = !0);
  3 === this.counter_read_mode[a] && (this.counter_next_low[a] ^= 1);
};
PIT.prototype.port43_write = function(a) {
  var c = a >> 1 & 7, d = a >> 6 & 3;
  a = a >> 4 & 3;
  3 !== d && (0 === a ? (this.counter_latch[d] = 2, this.counter_latch_value[d] = this.counter_current[d]) : (6 <= c && (c &= -5), this.counter_next_low[d] = 1 === a ? 0 : 1, this.counter_mode[d] = c, this.counter_read_mode[d] = a, 2 === d && (this.counter2_out = 0 === c ? 0 : 1)));
};
function VGAScreen(a, c, d) {
  this.bus = c;
  this.vga_memory_size = d;
  this.cursor_address = 0;
  this.cursor_scanline_start = 14;
  this.cursor_scanline_end = 15;
  this.max_cols = 80;
  this.max_rows = 25;
  this.start_address = this.screen_height = this.screen_width = 0;
  this.graphical_mode_is_linear = !0;
  this.do_complete_redraw = this.graphical_mode = !1;
  this.vga256_palette = new Int32Array(256);
  this.svga_height = this.svga_width = this.latch3 = this.latch2 = this.latch1 = this.latch0 = 0;
  this.text_mode_width = 80;
  this.svga_enabled = !1;
  this.svga_offset = this.svga_bpp = 0;
  this.pci_space = [222, 16, 32, 10, 7, 0, 0, 0, 162, 0, 0, 3, 0, 0, 128, 0, 8, 0, 0, 224, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 1, 0, 0];
  this.pci_id = 144;
  this.pci_bars = [{size:this.vga_memory_size}];
  a.devices.pci.register_device(this);
  this.stats = {is_graphical:!1, res_x:0, res_y:0, bpp:0};
  this.dac_color_index = this.index_crtc = 0;
  this.attribute_controller_index = -1;
  this.dac_map = new Uint8Array(16);
  this.sequencer_index = -1;
  this.plane_write_bm = 15;
  this.sequencer_memory_mode = 0;
  this.graphics_index = -1;
  this.planar_rotate_reg = this.planar_mode = this.plane_read = 0;
  this.planar_bitmap = 255;
  this.max_scan_line = 0;
  this.port_3DA_value = this.miscellaneous_output_register = 255;
  a = a.io;
  a.register_write(960, this, this.port3C0_write);
  a.register_read(960, this, this.port3C0_read);
  a.register_read(961, this, this.port3C1_read);
  a.register_write(962, this, this.port3C2_write);
  a.register_write_consecutive(964, this, this.port3C4_write, this.port3C5_write);
  a.register_read(964, this, this.port3C4_read);
  a.register_read(965, this, this.port3C5_read);
  a.register_write_consecutive(974, this, this.port3CE_write, this.port3CF_write);
  a.register_read(974, this, this.port3CE_read);
  a.register_read(975, this, this.port3CF_read);
  a.register_write(967, this, this.port3C7_write);
  a.register_write(968, this, this.port3C8_write);
  a.register_write(969, this, this.port3C9_write);
  a.register_read(972, this, this.port3CC_read);
  a.register_write_consecutive(980, this, this.port3D4_write, this.port3D5_write);
  a.register_read(981, this, this.port3D5_read);
  a.register_read(986, this, this.port3DA_read);
  this.dispi_index = -1;
  this.dispi_enable_value = 0;
  a.register_write(462, this, void 0, this.port1CE_write);
  a.register_write(463, this, void 0, this.port1CF_write);
  a.register_read(463, this, void 0, this.port1CF_read);
  void 0 === this.vga_memory_size || 262144 > this.vga_memory_size ? this.vga_memory_size = 262144 : this.vga_memory_size & 65535 && (this.vga_memory_size |= 65535, this.vga_memory_size++);
  this.svga_memory = new Uint8Array(this.vga_memory_size);
  this._state_restore();
  var e = this;
  a.mmap_register(655360, 131072, function(a) {
    return e.vga_memory_read(a);
  }, function(a, c) {
    e.vga_memory_write(a, c);
  });
  a.mmap_register(3758096384, this.vga_memory_size, function(a) {
    return e.svga_memory_read8(a);
  }, function(a, c) {
    e.svga_memory_write8(a, c);
  }, function(a) {
    return e.svga_memory_read32(a);
  }, function(a, c) {
    e.svga_memory_write32(a, c);
  });
}
VGAScreen.prototype._state_restore = function() {
  this.svga_memory16 = new Uint16Array(this.svga_memory.buffer);
  this.svga_memory32 = new Int32Array(this.svga_memory.buffer);
  this.vga_memory = new Uint8Array(this.svga_memory.buffer, 0, 262144);
  this.plane0 = new Uint8Array(this.svga_memory.buffer, 0, 65536);
  this.plane1 = new Uint8Array(this.svga_memory.buffer, 65536, 65536);
  this.plane2 = new Uint8Array(this.svga_memory.buffer, 131072, 65536);
  this.plane3 = new Uint8Array(this.svga_memory.buffer, 196608, 65536);
  this._state_skip = [this.bus, this.svga_memory16, this.svga_memory32, this.vga_memory, this.plane0, this.plane1, this.plane2, this.plane3];
  this.bus.send("screen-set-mode", this.graphical_mode || this.svga_enabled);
  this.graphical_mode || this.svga_enabled ? this.set_size_graphical(this.svga_width, this.svga_height) : (this.set_size_text(this.max_cols, this.max_rows), this.update_cursor_scanline(), this.update_cursor());
  this.do_complete_redraw = !0;
};
VGAScreen.prototype.vga_memory_read = function(a) {
  a -= 655360;
  if (!this.graphical_mode || this.graphical_mode_is_linear) {
    return this.vga_memory[a];
  }
  a &= 65535;
  this.latch0 = this.plane0[a];
  this.latch1 = this.plane1[a];
  this.latch2 = this.plane2[a];
  this.latch3 = this.plane3[a];
  return this.vga_memory[this.plane_read << 16 | a];
};
VGAScreen.prototype.vga_memory_write = function(a, c) {
  a -= 655360;
  this.graphical_mode ? this.graphical_mode_is_linear ? this.vga_memory_write_graphical_linear(a, c) : this.vga_memory_write_graphical_planar(a, c) : this.vga_memory_write_text_mode(a, c);
};
VGAScreen.prototype.vga_memory_write_graphical_linear = function(a, c) {
  var d = a << 2, e = this.vga256_palette[c];
  this.bus.send("screen-put-pixel-linear", [d | 2, e >> 16 & 255]);
  this.bus.send("screen-put-pixel-linear", [d | 1, e >> 8 & 255]);
  this.bus.send("screen-put-pixel-linear", [d, e & 255]);
  this.vga_memory[a] = c;
};
VGAScreen.prototype.vga_memory_write_graphical_planar = function(a, c) {
  if (!(65535 < a)) {
    var d, e, f, g, k = this.planar_mode & 3;
    0 === k ? d = e = f = g = c : 2 === k && (this.plane_write_bm & 1 && (d = this.latch0 & ~this.planar_bitmap | (c & 1 ? 255 : 0) & this.planar_bitmap), this.plane_write_bm & 2 && (e = this.latch1 & ~this.planar_bitmap | (c & 2 ? 255 : 0) & this.planar_bitmap), this.plane_write_bm & 4 && (f = this.latch2 & ~this.planar_bitmap | (c & 4 ? 255 : 0) & this.planar_bitmap), this.plane_write_bm & 8 && (g = this.latch3 & ~this.planar_bitmap | (c & 8 ? 255 : 0) & this.planar_bitmap));
    if (0 === k || 2 === k) {
      switch(this.planar_rotate_reg & 24) {
        case 8:
          d &= this.latch0;
          e &= this.latch1;
          f &= this.latch2;
          g &= this.latch3;
          break;
        case 16:
          d |= this.latch0;
          e |= this.latch1;
          f |= this.latch2;
          g |= this.latch3;
          break;
        case 24:
          d ^= this.latch0, e ^= this.latch1, f ^= this.latch2, g ^= this.latch3;
      }
      this.plane_write_bm & 1 && (d = this.latch0 & ~this.planar_bitmap | d & this.planar_bitmap);
      this.plane_write_bm & 2 && (e = this.latch1 & ~this.planar_bitmap | e & this.planar_bitmap);
      this.plane_write_bm & 4 && (f = this.latch2 & ~this.planar_bitmap | f & this.planar_bitmap);
      this.plane_write_bm & 8 && (g = this.latch3 & ~this.planar_bitmap | g & this.planar_bitmap);
    } else {
      1 === k && (d = this.latch0, e = this.latch1, f = this.latch2, g = this.latch3);
    }
    this.plane_write_bm & 1 ? this.plane0[a] = d : d = this.plane0[a];
    this.plane_write_bm & 2 ? this.plane1[a] = e : e = this.plane1[a];
    this.plane_write_bm & 4 ? this.plane2[a] = f : f = this.plane2[a];
    this.plane_write_bm & 8 ? this.plane3[a] = g : g = this.plane3[a];
    if (!(a >= this.screen_width * this.screen_height << 3)) {
      e <<= 1;
      f <<= 2;
      g <<= 3;
      for (var k = (a << 3 | 7) << 2, m = 0;8 > m;m++) {
        var l = this.vga256_palette[this.dac_map[d >> m & 1 | e >> m & 2 | f >> m & 4 | g >> m & 8]];
        this.bus.send("screen-put-pixel-linear", [k | 2, l >> 16]);
        this.bus.send("screen-put-pixel-linear", [k | 1, l >> 8 & 255]);
        this.bus.send("screen-put-pixel-linear", [k, l & 255]);
        k -= 4;
      }
    }
  }
};
VGAScreen.prototype.text_mode_redraw = function() {
  for (var a = 98304 | this.start_address << 1, c, d, e = 0;e < this.max_rows;e++) {
    for (var f = 0;f < this.max_cols;f++) {
      c = this.vga_memory[a], d = this.vga_memory[a | 1], this.bus.send("screen-put-char", [e, f, c, this.vga256_palette[d >> 4 & 15], this.vga256_palette[d & 15]]), a += 2;
    }
  }
};
VGAScreen.prototype.graphical_planar_redraw = function() {
  for (var a = 0, c = 0;c < this.screen_height;c++) {
    for (var d = 0;d < this.screen_width;d += 8) {
      for (var e = 0;8 > e;e++) {
        this.bus.send("screen-put-pixel-linear32", [c * this.screen_width + d << 2, this.vga256_palette[this.dac_map[this.plane0[a] >> e & 1 | this.plane1[a] >> e << 1 & 2 | this.plane2[a] >> e << 2 & 4 | this.plane3[a] >> e << 3 & 8]]]);
      }
      a++;
    }
  }
};
VGAScreen.prototype.vga_memory_write_text_mode = function(a, c) {
  if (!(98304 > a)) {
    var d = (a - 98304 >> 1) - this.start_address, e = d / this.max_cols | 0, d = d % this.max_cols, f, g;
    a & 1 ? (g = c, f = this.vga_memory[a & -2]) : (f = c, g = this.vga_memory[a | 1]);
    this.bus.send("screen-put-char", [e, d, f, this.vga256_palette[g >> 4 & 15], this.vga256_palette[g & 15]]);
    this.vga_memory[a] = c;
  }
};
VGAScreen.prototype.update_cursor = function() {
  var a = (this.cursor_address - this.start_address) / this.max_cols | 0, c = (this.cursor_address - this.start_address) % this.max_cols, a = Math.min(this.max_rows - 1, a);
  this.bus.send("screen-update-cursor", [a, c]);
};
VGAScreen.prototype.svga_memory_read8 = function(a) {
  return this.svga_memory[a & 268435455];
};
VGAScreen.prototype.svga_memory_read32 = function(a) {
  a &= 268435455;
  return a & 3 ? this.svga_memory[a] | this.svga_memory[a + 1] << 8 | this.svga_memory[a + 2] << 16 | this.svga_memory[a + 3] << 24 : this.svga_memory32[a >> 2];
};
VGAScreen.prototype.svga_memory_write8 = function(a, c) {
  a &= 268435455;
  this.svga_memory[a] = c;
  if (this.svga_enabled && (a -= this.svga_offset, !(0 > a))) {
    switch(this.svga_bpp) {
      case 32:
        3 !== (a & 3) && this.bus.send("screen-put-pixel-linear", [a, c]);
        break;
      case 24:
        this.bus.send("screen-put-pixel-linear", [(a << 2) / 3 | 0, c]);
        break;
      case 16:
        if (a & 1) {
          var d = this.svga_memory16[a >> 1], e, f;
          f = 255 * (c >> 3 & 31) / 31 | 0;
          e = 255 * (d >> 5 & 63) / 63 | 0;
          d = 255 * (d & 31) / 31 | 0;
          a <<= 1;
          this.bus.send("screen-put-pixel-linear", [a, d]);
          this.bus.send("screen-put-pixel-linear", [a - 1, e]);
          this.bus.send("screen-put-pixel-linear", [a - 2, f]);
        }
        break;
      case 8:
        e = this.vga256_palette[c], f = a << 2, this.bus.send("screen-put-pixel-linear", [f, e >> 16 & 255]), this.bus.send("screen-put-pixel-linear", [f | 1, e >> 8 & 255]), this.bus.send("screen-put-pixel-linear", [f | 2, e & 255]);
    }
  }
};
VGAScreen.prototype.svga_memory_write32 = function(a, c) {
  a &= 268435455;
  if (a & 3 || 32 !== this.svga_bpp) {
    this.svga_memory_write8(a, c & 255), this.svga_memory_write8(a + 1, c >> 8 & 255), this.svga_memory_write8(a + 2, c >> 16 & 255), this.svga_memory_write8(a + 3, c >> 24 & 255);
  } else {
    if (this.svga_memory32[a >> 2] = c, this.svga_enabled && (a -= this.svga_offset, !(0 > a))) {
      switch(this.svga_bpp) {
        case 32:
          this.bus.send("screen-put-pixel-linear32", [a, c]);
      }
    }
  }
};
VGAScreen.prototype.svga_redraw = function() {
  var a = this.svga_offset, c = this.svga_height * this.svga_width, d = 0;
  if (32 === this.svga_bpp) {
    for (var e = new Int32Array(this.svga_memory.buffer), a = a >> 2, c = c << 2;d < c;) {
      this.bus.send("screen-put-pixel-linear32", [d, e[a++]]), d += 4;
    }
  } else {
    if (24 === this.svga_bpp) {
      for (c <<= 2;d < c;) {
        this.bus.send("screen-put-pixel-linear", [d++, this.svga_memory[a++]]), this.bus.send("screen-put-pixel-linear", [d++, this.svga_memory[a++]]), this.bus.send("screen-put-pixel-linear", [d++, this.svga_memory[a++]]), d++;
      }
    }
  }
};
VGAScreen.prototype.timer = function() {
  this.do_complete_redraw && (this.do_complete_redraw = !1, this.svga_enabled ? this.svga_redraw() : this.graphical_mode ? this.graphical_mode_is_linear || this.graphical_planar_redraw() : this.text_mode_redraw());
};
VGAScreen.prototype.destroy = function() {
};
VGAScreen.prototype.set_size_text = function(a, c) {
  this.max_cols = a;
  this.max_rows = c;
  this.bus.send("screen-set-size-text", [a, c]);
};
VGAScreen.prototype.set_size_graphical = function(a, c) {
  this.bus.send("screen-set-size-graphical", [a, c]);
};
VGAScreen.prototype.update_cursor_scanline = function() {
  this.bus.send("screen-update-cursor-scanline", [this.cursor_scanline_start, this.cursor_scanline_end]);
};
VGAScreen.prototype.set_video_mode = function(a) {
  var c = !1;
  switch(a) {
    case 3:
      this.set_size_text(this.text_mode_width, 25);
      break;
    case 16:
      this.screen_width = 640;
      this.screen_height = 350;
      c = !0;
      this.graphical_mode_is_linear = !1;
      break;
    case 18:
      this.screen_width = 640;
      this.screen_height = 480;
      c = !0;
      this.graphical_mode_is_linear = !1;
      break;
    case 19:
      this.screen_width = 320, this.screen_height = 200, this.graphical_mode_is_linear = c = !0;
  }
  this.bus.send("screen-set-mode", c);
  if (this.stats.is_graphical = c) {
    this.set_size_graphical(this.screen_width, this.screen_height), this.stats.res_x = this.screen_width, this.stats.res_y = this.screen_height, this.stats.bpp = 8;
  }
  this.graphical_mode = c;
};
VGAScreen.prototype.port3C0_write = function(a) {
  -1 === this.attribute_controller_index ? this.attribute_controller_index = a : (16 > this.attribute_controller_index && (this.dac_map[this.attribute_controller_index] = a), this.attribute_controller_index = -1);
};
VGAScreen.prototype.port3C0_read = function() {
  var a = this.attribute_controller_index;
  this.attribute_controller_index = -1;
  return a;
};
VGAScreen.prototype.port3C1_read = function() {
  return this.attribute_controller_index = -1;
};
VGAScreen.prototype.port3C2_write = function(a) {
  this.miscellaneous_output_register = a;
  this.switch_video_mode(a);
};
VGAScreen.prototype.port3C4_write = function(a) {
  this.sequencer_index = a;
};
VGAScreen.prototype.port3C4_read = function() {
  return this.sequencer_index;
};
VGAScreen.prototype.port3C5_write = function(a) {
  switch(this.sequencer_index) {
    case 2:
      this.plane_write_bm = a;
      break;
    case 4:
      this.sequencer_memory_mode = a;
  }
};
VGAScreen.prototype.port3C5_read = function() {
  switch(this.sequencer_index) {
    case 2:
      return this.plane_write_bm;
    case 4:
      return this.sequencer_memory_mode;
    case 6:
      return 18;
  }
  return 0;
};
VGAScreen.prototype.port3C7_write = function() {
};
VGAScreen.prototype.port3C8_write = function(a) {
  this.dac_color_index = 3 * a;
};
VGAScreen.prototype.port3C9_write = function(a) {
  var c = this.dac_color_index / 3 | 0, d = this.dac_color_index % 3, e = this.vga256_palette[c];
  a = 255 * a / 63 & 255;
  this.vga256_palette[c] = 0 === d ? e & -16711681 | a << 16 : 1 === d ? e & -65281 | a << 8 : e & -256 | a;
  this.dac_color_index++;
  this.do_complete_redraw = !0;
};
VGAScreen.prototype.port3CC_read = function() {
  return this.miscellaneous_output_register;
};
VGAScreen.prototype.port3CE_write = function(a) {
  this.graphics_index = a;
};
VGAScreen.prototype.port3CE_read = function() {
  return this.graphics_index;
};
VGAScreen.prototype.port3CF_write = function(a) {
  switch(this.graphics_index) {
    case 3:
      this.planar_rotate_reg = a;
      break;
    case 4:
      this.plane_read = a;
      break;
    case 5:
      this.planar_mode = a;
      break;
    case 8:
      this.planar_bitmap = a;
  }
};
VGAScreen.prototype.port3CF_read = function() {
  switch(this.graphics_index) {
    case 3:
      return this.planar_rotate_reg;
    case 4:
      return this.plane_read;
    case 5:
      return this.planar_mode;
    case 8:
      return this.planar_bitmap;
  }
  return 0;
};
VGAScreen.prototype.port3D4_write = function(a) {
  this.index_crtc = a;
};
VGAScreen.prototype.port3D5_write = function(a) {
  switch(this.index_crtc) {
    case 2:
      this.text_mode_width = a;
      break;
    case 9:
      this.max_scan_line = a;
      7 === (a & 31) ? this.set_size_text(this.text_mode_width, 50) : this.set_size_text(this.text_mode_width, 25);
      break;
    case 10:
      this.cursor_scanline_start = a;
      this.update_cursor_scanline();
      break;
    case 11:
      this.cursor_scanline_end = a;
      this.update_cursor_scanline();
      break;
    case 12:
      this.start_address = this.start_address & 255 | a << 8;
      this.do_complete_redraw = !0;
      break;
    case 13:
      this.start_address = this.start_address & 65280 | a;
      this.do_complete_redraw = !0;
      break;
    case 14:
      this.cursor_address = this.cursor_address & 255 | a << 8;
      this.update_cursor();
      break;
    case 15:
      this.cursor_address = this.cursor_address & 65280 | a, this.update_cursor();
  }
};
VGAScreen.prototype.port3D5_read = function() {
  return 9 === this.index_crtc ? this.max_scan_line : 10 === this.index_crtc ? this.cursor_scanline_start : 11 === this.index_crtc ? this.cursor_scanline_end : 14 === this.index_crtc ? this.cursor_address >> 8 : 15 === this.index_crtc ? this.cursor_address & 255 : 0;
};
VGAScreen.prototype.port3DA_read = function() {
  this.port_3DA_value ^= 8;
  this.attribute_controller_index = -1;
  return this.port_3DA_value;
};
VGAScreen.prototype.switch_video_mode = function(a) {
  103 === a ? this.set_video_mode(3) : 227 === a ? this.set_video_mode(18) : 99 === a ? this.set_video_mode(19) : 163 === a ? this.set_video_mode(16) : this.set_video_mode(3);
};
VGAScreen.prototype.svga_bytes_per_line = function() {
  return this.svga_width * (15 === this.svga_bpp ? 16 : this.svga_bpp) / 8;
};
VGAScreen.prototype.port1CE_write = function(a) {
  this.dispi_index = a;
};
VGAScreen.prototype.port1CF_write = function(a) {
  switch(this.dispi_index) {
    case 1:
      this.svga_width = a;
      2560 < this.svga_width && (this.svga_width = 2560);
      break;
    case 2:
      this.svga_height = a;
      1600 < this.svga_height && (this.svga_height = 1600);
      break;
    case 3:
      this.svga_bpp = a;
      break;
    case 4:
      this.svga_enabled = 1 === (a & 1);
      this.dispi_enable_value = a;
      break;
    case 9:
      this.svga_offset = a * this.svga_bytes_per_line(), this.do_complete_redraw = !0;
  }
  !this.svga_enabled || this.svga_width && this.svga_height || (this.svga_enabled = !1);
  this.svga_enabled && 4 === this.dispi_index && (this.set_size_graphical(this.svga_width, this.svga_height), this.bus.send("screen-set-mode", !0), this.stats.bpp = this.svga_bpp, this.stats.is_graphical = !0, this.stats.res_x = this.svga_width, this.stats.res_y = this.svga_height);
};
VGAScreen.prototype.port1CF_read = function() {
  return this.svga_register_read(this.dispi_index);
};
VGAScreen.prototype.svga_register_read = function(a) {
  switch(a) {
    case 0:
      return 45248;
    case 1:
      return this.dispi_enable_value & 2 ? 2560 : this.svga_width;
    case 2:
      return this.dispi_enable_value & 2 ? 1600 : this.svga_height;
    case 3:
      return this.dispi_enable_value & 2 ? 32 : this.svga_bpp;
    case 4:
      return this.dispi_enable_value;
    case 6:
      return this.svga_width;
    case 10:
      return this.vga_memory_size / 65536 | 0;
  }
  return 255;
};
function PS2(a, c) {
  this.pic = a.devices.pic;
  this.cpu = a;
  this.bus = c;
  this.use_mouse = this.enable_mouse_stream = !1;
  this.mouse_clicks = this.mouse_delta_y = this.mouse_delta_x = 0;
  this.next_read_resolution = this.next_read_rate = this.next_handle_scan_code_set = this.next_read_led = this.next_read_sample = this.next_is_mouse_command = this.enable_keyboard_stream = !1;
  this.kbd_buffer = new ByteQueue(32);
  this.last_port60_byte = 0;
  this.sample_rate = 100;
  this.resolution = 4;
  this.scaling2 = !1;
  this.last_mouse_packet = -1;
  this.mouse_buffer = new ByteQueue(32);
  this.bus.register("keyboard-code", function(a) {
    this.kbd_send_code(a);
  }, this);
  this.bus.register("mouse-click", function(a) {
    this.mouse_send_click(a[0], a[1], a[2]);
  }, this);
  this.bus.register("mouse-delta", function(a) {
    this.mouse_send_delta(a[0], a[1]);
  }, this);
  this.bus.register("mouse-wheel", function() {
  }, this);
  this.command_register = 5;
  this.read_command_register = this.read_output_register = !1;
  a.io.register_read(96, this, this.port60_read);
  a.io.register_read(100, this, this.port64_read);
  a.io.register_write(96, this, this.port60_write);
  a.io.register_write(100, this, this.port64_write);
  this._state_skip = [this.bus, this.pic, this.cpu];
}
PS2.prototype.mouse_irq = function() {
  this.command_register & 2 && this.pic.push_irq(12);
};
PS2.prototype.kbd_irq = function() {
  this.command_register & 1 && this.pic.push_irq(1);
};
PS2.prototype.kbd_send_code = function(a) {
  this.enable_keyboard_stream && (this.kbd_buffer.push(a), this.kbd_irq());
};
PS2.prototype.mouse_send_delta = function(a, c) {
  if (this.use_mouse) {
    var d = this.resolution * this.sample_rate / 80;
    this.mouse_delta_x += a * d;
    this.mouse_delta_y += c * d;
    if (this.enable_mouse_stream) {
      var d = this.mouse_delta_x | 0, e = this.mouse_delta_y | 0;
      !d && !e || Date.now() - this.last_mouse_packet < 1E3 / this.sample_rate || (this.mouse_delta_x -= d, this.mouse_delta_y -= e, this.send_mouse_packet(d, e));
    }
  }
};
PS2.prototype.mouse_send_click = function(a, c, d) {
  this.use_mouse && (this.mouse_clicks = a | d << 1 | c << 2, this.enable_mouse_stream && this.send_mouse_packet(0, 0));
};
PS2.prototype.send_mouse_packet = function(a, c) {
  var d = (0 > c) << 5 | (0 > a) << 4 | 8 | this.mouse_clicks, e = a, f = c;
  this.last_mouse_packet = Date.now();
  this.scaling2 && (e = this.apply_scaling2(e), f = this.apply_scaling2(f));
  this.mouse_buffer.push(d);
  this.mouse_buffer.push(e);
  this.mouse_buffer.push(f);
  this.mouse_irq();
};
PS2.prototype.apply_scaling2 = function(a) {
  var c = a >> 31;
  switch(Math.abs(a)) {
    case 0:
    ;
    case 1:
    ;
    case 3:
      return a;
    case 2:
      return c;
    case 4:
      return 6 * c;
    case 5:
      return 9 * c;
    default:
      return a << 1;
  }
};
PS2.prototype.destroy = function() {
};
PS2.prototype.port60_read = function() {
  if (!this.kbd_buffer.length && !this.mouse_buffer.length) {
    return this.last_port60_byte;
  }
  (this.kbd_buffer.length && this.mouse_buffer.length ? 0 !== (this.pic.isr & 2) : this.kbd_buffer.length) ? (this.last_port60_byte = this.kbd_buffer.shift(), 1 <= this.kbd_buffer.length && this.kbd_irq()) : (this.last_port60_byte = this.mouse_buffer.shift(), 1 <= this.mouse_buffer.length && this.mouse_irq());
  return this.last_port60_byte;
};
PS2.prototype.port64_read = function() {
  var a = 16;
  if (this.mouse_buffer.length || this.kbd_buffer.length) {
    a |= 1;
  }
  this.mouse_buffer.length && (a |= 32);
  return a;
};
PS2.prototype.port60_write = function(a) {
  if (this.read_command_register) {
    this.kbd_irq(), this.command_register = a, this.read_command_register = !1;
  } else {
    if (this.read_output_register) {
      this.read_output_register = !1, this.mouse_buffer.clear(), this.mouse_buffer.push(a), this.mouse_irq();
    } else {
      if (this.next_read_sample) {
        this.next_read_sample = !1, this.mouse_buffer.clear(), this.mouse_buffer.push(250), this.sample_rate = a, this.mouse_irq();
      } else {
        if (this.next_read_resolution) {
          this.next_read_resolution = !1, this.mouse_buffer.clear(), this.mouse_buffer.push(250), this.resolution = 3 < a ? 4 : 1 << a, this.mouse_irq();
        } else {
          if (this.next_read_led) {
            this.next_read_led = !1, this.kbd_buffer.push(250), this.kbd_irq();
          } else {
            if (this.next_handle_scan_code_set) {
              this.next_handle_scan_code_set = !1, this.kbd_buffer.push(250), this.kbd_irq(), a || this.kbd_buffer.push(2);
            } else {
              if (this.next_read_rate) {
                this.next_read_rate = !1, this.kbd_buffer.push(250), this.kbd_irq();
              } else {
                if (this.next_is_mouse_command) {
                  this.next_is_mouse_command = !1;
                  this.kbd_buffer.clear();
                  this.mouse_buffer.clear();
                  this.mouse_buffer.push(250);
                  switch(a) {
                    case 230:
                      this.scaling2 = !1;
                      break;
                    case 231:
                      this.scaling2 = !0;
                      break;
                    case 232:
                      this.next_read_resolution = !0;
                      break;
                    case 233:
                      this.send_mouse_packet(0, 0);
                      break;
                    case 242:
                      this.mouse_buffer.push(0);
                      this.mouse_buffer.push(0);
                      this.mouse_clicks = this.mouse_delta_x = this.mouse_delta_y = 0;
                      break;
                    case 243:
                      this.next_read_sample = !0;
                      break;
                    case 244:
                      this.use_mouse = this.enable_mouse_stream = !0;
                      this.bus.send("mouse-enable", !0);
                      this.mouse_clicks = this.mouse_delta_x = this.mouse_delta_y = 0;
                      break;
                    case 245:
                      this.enable_mouse_stream = !1;
                      break;
                    case 246:
                      this.enable_mouse_stream = !1;
                      this.sample_rate = 100;
                      this.scaling2 = !1;
                      this.resolution = 4;
                      break;
                    case 255:
                      this.mouse_buffer.push(170), this.mouse_buffer.push(0), this.use_mouse = !0, this.bus.send("mouse-enable", !0), this.enable_mouse_stream = !1, this.sample_rate = 100, this.scaling2 = !1, this.resolution = 4, this.mouse_clicks = this.mouse_delta_x = this.mouse_delta_y = 0;
                  }
                  this.mouse_irq();
                } else {
                  this.mouse_buffer.clear();
                  this.kbd_buffer.clear();
                  this.kbd_buffer.push(250);
                  switch(a) {
                    case 237:
                      this.next_read_led = !0;
                      break;
                    case 240:
                      this.next_handle_scan_code_set = !0;
                      break;
                    case 242:
                      this.kbd_buffer.push(171);
                      this.kbd_buffer.push(83);
                      break;
                    case 243:
                      this.next_read_rate = !0;
                      break;
                    case 244:
                      this.enable_keyboard_stream = !0;
                      break;
                    case 245:
                      this.enable_keyboard_stream = !1;
                      break;
                    case 255:
                      this.kbd_buffer.clear(), this.kbd_buffer.push(250), this.kbd_buffer.push(170);
                  }
                  this.kbd_irq();
                }
              }
            }
          }
        }
      }
    }
  }
};
PS2.prototype.port64_write = function(a) {
  switch(a) {
    case 32:
      this.kbd_buffer.clear();
      this.mouse_buffer.clear();
      this.kbd_buffer.push(this.command_register);
      break;
    case 96:
      this.read_command_register = !0;
      break;
    case 211:
      this.read_output_register = !0;
      break;
    case 212:
      this.next_is_mouse_command = !0;
      break;
    case 167:
      this.command_register |= 32;
      break;
    case 168:
      this.command_register &= -33;
      break;
    case 169:
      this.kbd_buffer.clear();
      this.mouse_buffer.clear();
      this.kbd_buffer.push(0);
      break;
    case 170:
      this.kbd_buffer.clear();
      this.mouse_buffer.clear();
      this.kbd_buffer.push(85);
      break;
    case 171:
      this.kbd_buffer.clear();
      this.mouse_buffer.clear();
      this.kbd_buffer.push(0);
      break;
    case 173:
      this.command_register |= 16;
      break;
    case 174:
      this.command_register &= -17;
      break;
    case 254:
      this.cpu.reboot_internal();
  }
};
function PIC(a, c) {
  this.irr = this.isr = this.irq_map = this.irq_mask = 0;
  this.is_master = void 0 === c;
  this.slave = void 0;
  this.expect_icw4 = !1;
  this.state = 0;
  this.auto_eoi = this.read_irr = 1;
  this.is_master ? (this.slave = new PIC(a, this), this.check_irqs = function() {
    var c = this.irr & this.irq_mask;
    if (!c) {
      return this.slave.check_irqs();
    }
    c &= -c;
    if (this.isr && (this.isr & -this.isr) <= c) {
      return!1;
    }
    var d = int_log2_table[c], c = 1 << d;
    this.irr &= ~c;
    if (4 === c) {
      return this.slave.check_irqs();
    }
    this.auto_eoi || (this.isr |= c);
    a.previous_ip = a.instruction_pointer;
    a.call_interrupt_vector(this.irq_map | d, !1, !1);
    return!0;
  }) : this.check_irqs = function() {
    var d = this.irr & this.irq_mask;
    if (!d) {
      return!1;
    }
    d &= -d;
    if (this.isr && (this.isr & -this.isr) <= d) {
      return!1;
    }
    var f = int_log2_table[d], d = 1 << f;
    this.irr &= ~d;
    this.isr |= d;
    a.previous_ip = a.instruction_pointer;
    a.call_interrupt_vector(this.irq_map | f, !1, !1);
    this.irr && c.push_irq(2);
    this.auto_eoi || (this.isr &= ~d);
    return!0;
  };
  this.PIC$dump = function() {
    this.is_master && this.slave.PIC$dump();
  };
  var d;
  d = this.is_master ? 32 : 160;
  a.io.register_write(d, this, function(a) {
    if (a & 16) {
      this.expect_icw4 = a & 1, this.state = 1;
    } else {
      if (a & 8) {
        this.read_irr = a & 1;
      } else {
        var c = a >> 5;
        1 === c ? this.isr &= this.isr - 1 : 3 === c && (this.isr &= ~(1 << (a & 7)));
      }
    }
  });
  a.io.register_read(d, this, function() {
    return this.read_irr ? this.irr : this.isr;
  });
  a.io.register_write(d | 1, this, function(a) {
    0 === this.state ? this.expect_icw4 ? (this.expect_icw4 = !1, this.auto_eoi = a & 2) : this.irq_mask = ~a : 1 === this.state ? (this.irq_map = a, this.state++) : 2 === this.state && (this.state = 0);
  });
  a.io.register_read(d | 1, this, function() {
    return~this.irq_mask & 255;
  });
  this.push_irq = this.is_master ? function(c) {
    8 <= c && (this.slave.push_irq(c - 8), c = 2);
    this.irr |= 1 << c;
    a.handle_irqs();
  } : function(a) {
    this.irr |= 1 << a;
  };
}
;function RTC(a, c, d) {
  this.cpu = a;
  this.pic = a.devices.pic;
  this.cmos_index = 0;
  this.boot_order = d;
  this.diskette_type = c;
  this.last_update = this.rtc_time = Date.now();
  this.next_interrupt = 0;
  this.cmos_c_was_read = !0;
  this.periodic_interrupt = !1;
  this.periodic_interrupt_time = .9765625;
  this.cmos_a = 38;
  this.cmos_b = 2;
  this.cmos_c = 0;
  a.io.register_write(112, this, function(a) {
    this.cmos_index = a & 127;
  });
  a.io.register_write(113, this, this.cmos_write);
  a.io.register_read(113, this, this.cmos_read);
  this._state_skip = [this.cpu, this.pic];
}
RTC.prototype.timer = function(a) {
  this.periodic_interrupt && this.cmos_c_was_read && this.next_interrupt < a && (this.cmos_c_was_read = !1, this.pic.push_irq(8), this.cmos_c |= 64, this.next_interrupt += this.periodic_interrupt_time * Math.ceil((a - this.next_interrupt) / this.periodic_interrupt_time));
  this.rtc_time += a - this.last_update;
  this.last_update = a;
};
RTC.prototype.bcd_pack = function(a) {
  for (var c = 0, d = 0, e;a;) {
    e = a % 10, d |= e << 4 * c, c++, a = (a - e) / 10;
  }
  return d;
};
RTC.prototype.encode_time = function(a) {
  return this.cmos_b & 4 ? a : this.bcd_pack(a);
};
RTC.prototype.cmos_read = function() {
  switch(this.cmos_index) {
    case 0:
      return this.encode_time((new Date(this.rtc_time)).getUTCSeconds());
    case 2:
      return this.encode_time((new Date(this.rtc_time)).getUTCMinutes());
    case 4:
      return this.encode_time((new Date(this.rtc_time)).getUTCHours());
    case 7:
      return this.encode_time((new Date(this.rtc_time)).getUTCDate());
    case 8:
      return this.encode_time((new Date(this.rtc_time)).getUTCMonth() + 1);
    case 9:
      return this.encode_time((new Date(this.rtc_time)).getUTCFullYear() % 100);
    case 10:
      return this.cmos_a;
    case 11:
      return this.cmos_b;
    case 14:
      return 0;
    case 12:
      return this.cmos_c_was_read = !0, this.cmos_c;
    case 15:
      return 0;
    case 16:
      return this.diskette_type;
    case 20:
      return 45;
    case 50:
      return this.encode_time((new Date(this.rtc_time)).getUTCFullYear() / 100 | 0);
    case 52:
      return this.cpu.memory_size - 16777216 >> 16 & 255;
    case 53:
      return this.cpu.memory_size - 16777216 >> 24 & 255;
    case 56:
      return 1 | this.boot_order >> 4 & 240;
    case 61:
      return this.boot_order & 255;
    case 91:
    ;
    case 92:
    ;
    case 93:
      return 0;
  }
  return 255;
};
RTC.prototype.cmos_write = function(a) {
  switch(this.cmos_index) {
    case 10:
      this.cmos_a = a & 127;
      this.periodic_interrupt_time = 1E3 / (32768 >> (this.cmos_a & 15) - 1);
      break;
    case 11:
      this.cmos_b = a, this.cmos_b & 64 && (this.next_interrupt = Date.now());
  }
  this.periodic_interrupt = 64 === (this.cmos_b & 64) && 0 < (this.cmos_a & 15);
};
function UART(a, c, d) {
  this.bus = d;
  this.pic = a.devices.pic;
  this.ier = this.line_control = this.baud_rate = this.ints = 0;
  this.iir = 1;
  this.UART$irq = this.scratch_register = this.modem_status = this.modem_control = 0;
  this.input = new ByteQueue(4096);
  this.current_line = "";
  if (1E3 === c || 1016 === c) {
    this.UART$irq = 4;
  } else {
    if (1E3 === c || 1E3 === c) {
      this.UART$irq = 3;
    } else {
      return;
    }
  }
  this.bus.register("serial0-input", function(a) {
    this.data_received(a);
  }, this);
  a = a.io;
  a.register_write(c, this, function(a) {
    this.line_control & 128 ? this.baud_rate = this.baud_rate & -256 | a : (this.ThrowTHRI(), 255 !== a && (a = String.fromCharCode(a), this.bus.send("serial0-output-char", a), this.bus.should_send() && (this.current_line += a, "\n" === a && (this.bus.send("serial0-output-line", this.current_line), this.current_line = ""))));
  });
  a.register_write(c | 1, this, function(a) {
    this.line_control & 128 ? this.baud_rate = this.baud_rate & 255 | a << 8 : (this.ier = a, this.NextInterrupt());
  });
  a.register_read(c, this, function() {
    if (this.line_control & 128) {
      return this.baud_rate & 255;
    }
    var a = this.input.shift();
    this.input.length && this.ThrowCTI();
    return a;
  });
  a.register_read(c | 1, this, function() {
    return this.line_control & 128 ? this.baud_rate >> 8 : this.ier;
  });
  a.register_read(c | 2, this, function() {
    var a = this.iir & 15 | 192;
    2 === this.iir ? this.ClearInterrupt(2) : 12 === this.iir && this.ClearInterrupt(12);
    return a;
  });
  a.register_write(c | 2, this, function() {
  });
  a.register_read(c | 3, this, function() {
    return this.line_control;
  });
  a.register_write(c | 3, this, function(a) {
    this.line_control = a;
  });
  a.register_read(c | 4, this, function() {
    return this.modem_control;
  });
  a.register_write(c | 4, this, function(a) {
    this.modem_control = a;
  });
  a.register_read(c | 5, this, function() {
    var a = 0;
    this.input.length && (a |= 1);
    return a | 96;
  });
  a.register_write(c | 5, this, function() {
  });
  a.register_read(c | 6, this, function() {
    return this.modem_status;
  });
  a.register_write(c | 6, this, function() {
  });
  a.register_read(c | 7, this, function() {
    return this.scratch_register;
  });
  a.register_write(c | 7, this, function(a) {
    this.scratch_register = a;
  });
  this._state_skip = [this.bus, this.pic];
}
UART.prototype.push_irq = function() {
  this.pic.push_irq(this.UART$irq);
};
UART.prototype.ClearInterrupt = function(a) {
  this.ints &= ~(1 << a);
  this.iir = 1;
  a === this.iir && this.NextInterrupt();
};
UART.prototype.ThrowCTI = function() {
  this.ints |= 4096;
  this.ier & 1 && 6 != this.iir && 4 != this.iir && (this.iir = 12, this.push_irq());
};
UART.prototype.ThrowTHRI = function() {
  this.ints |= 4;
  this.ier & 2 && (this.iir & 1 || 0 == this.iir || 2 == this.iir) && (this.iir = 2, this.push_irq());
};
UART.prototype.NextInterrupt = function() {
  this.ints & 4096 && this.ier & 1 ? this.ThrowCTI() : this.ints & 4 && this.ier & 2 ? this.ThrowTHRI() : this.iir = 1;
};
UART.prototype.data_received = function(a) {
  this.input.push(a);
  this.ints |= 4096;
  this.ier & 1 && this.ThrowCTI();
};
function ACPI() {
}
;function StateLoadError(a) {
  this.message = a;
}
StateLoadError.prototype = Error();
function save_object(a, c) {
  if ("object" !== typeof a || null === a || a instanceof Array) {
    return a;
  }
  if (a.constructor === Object) {
    for (var d = Object.keys(a), e = {}, f = 0;f < d.length;f++) {
      var g = d[f];
      e[g] = save_object(a[g], c);
    }
    return e;
  }
  if (a.BYTES_PER_ELEMENT) {
    return{__state_type__:a.constructor.name, buffer_id:c.push(a.buffer) - 1};
  }
  if (a instanceof ArrayBuffer) {
    return{__state_type__:"ArrayBuffer", buffer_id:c.push(a) - 1};
  }
  var k;
  a._state_skip && (k = a._state_skip.slice(), k.push(a._state_skip));
  d = Object.keys(a);
  e = {};
  f = 0;
  a: for (;f < d.length;f++) {
    var g = d[f], m = a[g];
    if ("function" !== typeof m) {
      if (k && "object" === typeof m && m) {
        for (var l = 0;l < k.length;l++) {
          if (k[l] === m) {
            continue a;
          }
        }
      }
      e[g] = save_object(m, c);
    }
  }
  return e;
}
function restore_object(a, c, d) {
  if ("object" !== typeof c || c instanceof Array || null === c) {
    return c;
  }
  var e = c.__state_type__;
  if (void 0 === e) {
    for (var e = Object.keys(c), f = 0;f < e.length;f++) {
      var g = e[f];
      a[g] = restore_object(a[g], c[g], d);
    }
    a._state_restore && a._state_restore();
    return a;
  }
  if ("ArrayBuffer" === e) {
    return c = d.infos[c.buffer_id], a && a.byteLength === c.length && (new Uint8Array(a)).set(new Uint8Array(d.full, c.offset, c.length)), a;
  }
  e = {Uint8Array:Uint8Array, Int8Array:Int8Array, Uint16Array:Uint16Array, Int16Array:Int16Array, Uint32Array:Uint32Array, Int32Array:Int32Array, Float32Array:Float32Array, Float64Array:Float64Array}[e];
  c = d.infos[c.buffer_id];
  return a && a.constructor === e && 0 === a.byteOffset && a.byteLength === c.length ? ((new Uint8Array(a.buffer)).set(new Uint8Array(d.full, c.offset, c.length), a.byteOffset), a) : new e(d.full.slice(c.offset, c.offset + c.length));
}
CPU.prototype.CPU_prototype$save_state = function() {
  for (var a = [], c = save_object(this, a), d = [], e = 0, f = 0;f < a.length;f++) {
    var g = a[f].byteLength;
    d[f] = {offset:e, length:g};
    e += g;
    e = e + 3 & -4;
  }
  var c = JSON.stringify({buffer_infos:d, state:c}), f = 16 + 2 * c.length, k = f + e, e = new ArrayBuffer(k), m = new Int32Array(e, 0, 4), g = new Uint16Array(e, 16, c.length), l = new Uint8Array(e, f);
  m[0] = -2039052682;
  m[1] = 0;
  m[2] = k;
  m[3] = 2 * c.length;
  for (f = 0;f < c.length;f++) {
    g[f] = c.charCodeAt(f);
  }
  for (f = 0;f < a.length;f++) {
    l.set(new Uint8Array(a[f]), d[f].offset);
  }
  return e;
};
CPU.prototype.CPU_prototype$restore_state = function(a) {
  var c = a.byteLength;
  if (16 > c) {
    throw new StateLoadError("Invalid length: " + c);
  }
  var d = new Int32Array(a, 0, 4);
  if (-2039052682 !== d[0]) {
    throw new StateLoadError("Invalid header: " + h(d[0] >>> 0));
  }
  if (0 !== d[1]) {
    throw new StateLoadError("Version mismatch: dump=" + d[1] + " we=0");
  }
  if (d[2] !== c) {
    throw new StateLoadError("Length doesn't match header: real=" + c + " header=" + d[2]);
  }
  d = d[3];
  if (0 > d || d + 12 >= c || d % 2) {
    throw new StateLoadError("Invalid info block length: " + d);
  }
  for (var e = d / 2, f = new Uint16Array(a, 16, e), g = "", c = 0;c < e - 8;) {
    g += String.fromCharCode(f[c++], f[c++], f[c++], f[c++], f[c++], f[c++], f[c++], f[c++]);
  }
  for (;c < e;) {
    g += String.fromCharCode(f[c++]);
  }
  e = JSON.parse(g);
  d = 16 + d;
  f = e.buffer_infos;
  for (c = 0;c < f.length;c++) {
    f[c].offset += d;
  }
  restore_object(this, e.state, {full:a, infos:f});
};
function Ne2k(a, c) {
  this.pic = a.devices.pic;
  this.bus = c;
  this.bus.register("net0-receive", function(a) {
    this.receive(a);
  }, this);
  this.pci_space = [236, 16, 41, 128, 3, 1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 244, 26, 0, 17, 0, 0, 184, 254, 0, 0, 0, 0, 0, 0, 0, 0, 11, 1, 0, 0];
  this.pci_id = 40;
  this.pci_bars = [{size:131072}];
  a.devices.pci.register_device(this);
  this.imr = this.isr = 0;
  this.cr = 1;
  this.rcnt = 0;
  this.remote_buffer = new Uint8Array(0);
  this.remote_pointer = 0;
  this.receive_buffer = new Uint8Array(32768);
  this.receive_buffer[0] = 0;
  this.receive_buffer[1] = 34;
  this.receive_buffer[2] = 21;
  this.receive_buffer[3] = 255 * Math.random() | 0;
  this.receive_buffer[4] = 255 * Math.random() | 0;
  this.receive_buffer[5] = 255 * Math.random() | 0;
  this.rsar = 0;
  this.boundary = this.curpg = 76;
  var d = a.io;
  d.register_read(47104, this, function() {
    return this.cr;
  });
  d.register_write(47104, this, function(a) {
    this.cr = a | this.cr & 4;
    this.remote_pointer = 0;
    this.rcnt > this.remote_buffer.length && (this.remote_buffer = new Uint8Array(this.rcnt));
  });
  d.register_read(47117, this, function() {
    return 0;
  });
  d.register_read(47118, this, function() {
    return 0;
  });
  d.register_read(47119, this, function() {
    return 0;
  });
  d.register_read(47135, this, function() {
    if (0 === (this.cr & 192)) {
      return this.do_interrupt(128), 0;
    }
  });
  d.register_write(47135, this, function() {
  });
  d.register_read(47111, this, function() {
    return 0 === (this.cr & 192) ? this.isr : this.curpg;
  });
  d.register_write(47111, this, function(a) {
    0 === (this.cr & 192) ? this.isr &= ~a : this.curpg = a;
  });
  d.register_write(47117, this, function() {
  });
  d.register_write(47118, this, function() {
  });
  d.register_write(47114, this, function(a) {
    0 === (this.cr & 192) && (this.rcnt = this.rcnt & 65280 | a & 255);
  });
  d.register_write(47115, this, function(a) {
    0 === (this.cr & 192) && (this.rcnt = this.rcnt & 255 | a << 8 & 65280);
  });
  d.register_write(47112, this, function(a) {
    0 === (this.cr & 192) && (this.rsar = this.rsar & 65280 | a & 255);
  });
  d.register_write(47113, this, function(a) {
    0 === (this.cr & 192) && (this.rsar = this.rsar & 255 | a << 8 & 65280);
  });
  d.register_write(47119, this, function(a) {
    0 === (this.cr & 192) && (this.imr = a);
  });
  d.register_read(47107, this, function() {
    return 0 === (this.cr & 192) ? this.boundary : 0;
  });
  d.register_write(47107, this, function(a) {
    0 === (this.cr & 192) && (this.boundary = a);
  });
  d.register_read(47108, this, function() {
    return 0 === (this.cr & 192) ? 35 : 0;
  });
  d.register_read(47116, this, function() {
    return 0 === (this.cr & 192) ? 9 : 0;
  });
  d.register_read(47120, this, this.data_port_read, this.data_port_read16, this.data_port_read32);
  d.register_write(47120, this, this.data_port_write, this.data_port_write16, this.data_port_write32);
  this._state_skip = [this.bus, this.pic];
}
Ne2k.prototype.do_interrupt = function(a) {
  this.isr |= a;
  this.imr & a && this.pic.push_irq(11);
};
Ne2k.prototype.data_port_write = function(a) {
  this.remote_buffer[this.remote_pointer++] = a;
  this.remote_pointer === this.rcnt && (a = this.remote_buffer.subarray(0, this.rcnt), this.do_interrupt(64), this.cr &= -5, this.bus.send("net0-send", a), this.do_interrupt(2));
};
Ne2k.prototype.data_port_write16 = function(a) {
  this.data_port_write(a);
  this.data_port_write(a >> 8);
};
Ne2k.prototype.data_port_write32 = function(a) {
  this.data_port_write(a);
  this.data_port_write(a >> 8);
  this.data_port_write(a >> 16);
  this.data_port_write(a >> 24);
};
Ne2k.prototype.data_port_read = function() {
  return this.receive_buffer[this.rsar++];
};
Ne2k.prototype.data_port_read16 = function() {
  return this.data_port_read() | this.data_port_read() << 8;
};
Ne2k.prototype.data_port_read32 = function() {
  return this.data_port_read() | this.data_port_read() << 8 | this.data_port_read() << 16 | this.data_port_read() << 24;
};
Ne2k.prototype.receive = function(a) {
  if (!(this.cr & 1)) {
    if (60 > a.length) {
      var c = a;
      a = new Uint8Array(60);
      a.set(c);
    }
    var c = this.curpg << 8, d = a.length + 4, e = c + 4, f = this.curpg + 1 + (d >> 8);
    if (c + d > this.receive_buffer.length) {
      var g = this.receive_buffer.length - e;
      this.receive_buffer.set(a.subarray(0, g), e);
      this.receive_buffer.set(a.subarray(g), 76);
    } else {
      this.receive_buffer.set(a, e);
    }
    128 <= f && (f += -52);
    this.receive_buffer[c] = 1;
    this.receive_buffer[c + 1] = f;
    this.receive_buffer[c + 2] = d;
    this.receive_buffer[c + 3] = d >> 8;
    this.curpg = f;
    this.do_interrupt(1);
  }
};
function VirtIO(a, c) {
  this.pci_space = [244, 26, 9, 16, 7, 5, 16, 0, 0, 0, 2, 0, 0, 0, 0, 0, 1, 168, 0, 0, 0, 16, 191, 254, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 244, 26, 9, 0, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 12, 1, 0, 0];
  this.pci_id = 48;
  this.pci_bars = [{size:131072}];
  a.devices.pci.register_device(this);
  var d = a.io;
  d.register_read(43008, this, void 0, void 0, function() {
    return 1;
  });
  d.register_write(43012, this, void 0, void 0, function() {
  });
  d.register_write(43022, this, void 0, function(a) {
    this.queue_select = a;
  }, void 0);
  d.register_read(43020, this, void 0, function() {
    return this.queue_size;
  }, void 0);
  d.register_read(43016, this, void 0, void 0, function() {
    return 0 === this.queue_select ? this.queue_address : 0;
  });
  d.register_write(43016, this, void 0, void 0, function(a) {
    this.queue_address = a;
  });
  d.register_write(43026, this, function(a) {
    this.device_status = a;
  });
  d.register_read(43026, this, function() {
    return this.device_status;
  });
  d.register_read(43027, this, function() {
    var a = this.isr;
    this.isr = 0;
    return a;
  });
  d.register_write(43024, this, void 0, function() {
    var a = (this.queue_address << 12) + 16 * this.queue_size, c = a + 4;
    this.memory.read16(a);
    for (var a = this.memory.read16(a + 2), d = this.queue_size - 1, a = a & d;this.last_idx !== a;) {
      var e = this.memory.read16(c + 2 * this.last_idx);
      this.handle_descriptor(e);
      this.last_idx = this.last_idx + 1 & d;
    }
  });
  this.pic = a.devices.pic;
  this.last_idx = this.isr = this.device_status = this.queue_select = 0;
  this.queue_size = 32;
  this.queue_address = 0;
  this.memory = a.memory;
  for (var e = 0;128 > e;e++) {
    d.register_read(43028 + e, this, function(a) {
      return this.device.configspace[a];
    }.bind(this, e), void 0, void 0), d.register_write(43028 + e, this, function() {
    }.bind(this, e), void 0, void 0);
  }
  this.device = new Virtio9p(c);
  this.device.SendReply = this.device_reply.bind(this);
  this._state_skip = [this.memory, this.pic, this.device];
  this._state_restore = function() {
    this.device.SendReply = this.device_reply.bind(this);
  };
}
VirtIO.prototype.handle_descriptor = function(a) {
  var c = a, d = this.queue_address << 12, e = 0, f = [];
  do {
    var g = d + 16 * c, k = this.memory.read16(g + 12);
    if (k & 2) {
      break;
    }
    var m = this.memory.read32s(g), c = this.memory.read32s(g + 4), l = this.memory.read32s(g + 8) >>> 0;
    f.push({addr_low:m, addr_high:c, len:l});
    if (k & 1) {
      c = this.memory.read16(g + 14);
    } else {
      c = -1;
      break;
    }
  } while (1);
  var n = -1, p = 0;
  this.device.ReceiveRequest({start:a, next:c}, function() {
    if (p >= n) {
      if (e === f.length) {
        return 0;
      }
      var a = f[e++];
      m = a.addr_low;
      n = a.len;
      p = 0;
    }
    return this.memory.read8(m + p++);
  }.bind(this));
};
VirtIO.prototype.device_reply = function(a) {
  if (-1 !== a.next) {
    var c = this.device.replybuffersize, d = a.next, e = this.queue_address << 12, f = 0, g = [];
    do {
      var d = e + 16 * d, k = this.memory.read16(d + 12);
      if (0 === (k & 2)) {
        break;
      }
      var m = this.memory.read32s(d), l = this.memory.read32s(d + 4), n = this.memory.read32s(d + 8) >>> 0;
      g.push({addr_low:m, addr_high:l, len:n});
      if (k & 1) {
        d = this.memory.read16(d + 14);
      } else {
        break;
      }
    } while (1);
    k = -1;
    for (e = l = 0;e < c;e++) {
      d = this.device.replybuffer[e];
      if (l >= k) {
        if (f === g.length) {
          return 0;
        }
        k = g[f++];
        m = k.addr_low;
        k = k.len;
        l = 0;
      }
      this.memory.write8(m + l++, d);
    }
    f = (this.queue_address << 12) + 580;
    f = f + 4095 & -4096;
    this.memory.read16(f);
    g = this.memory.read16(f + 2);
    this.memory.write16(f + 2, g + 1);
    f = f + 4 + 8 * (g & 31);
    this.memory.write32(f, a.start);
    this.memory.write32(f + 4, c);
    this.isr |= 1;
    this.pic.push_irq(12);
  }
};
var Bus = {Connector:function() {
  this.listeners = {};
  this.pair = void 0;
}};
Bus.Connector.prototype.register = function(a, c, d) {
  var e = this.listeners[a];
  void 0 === e && (e = this.listeners[a] = []);
  e.push({fn:c, this_value:d});
};
Bus.Connector.prototype.unregister = function(a, c) {
  var d = this.listeners[a];
  void 0 !== d && (this.listeners[a] = d.filter(function(a) {
    return a.fn !== c;
  }));
};
Bus.Connector.prototype.send = function(a, c) {
  if (this.pair) {
    var d = this.pair.listeners[a];
    if (void 0 !== d) {
      for (var e = 0;e < d.length;e++) {
        var f = d[e];
        f.fn.call(f.this_value, c);
      }
    }
  }
};
Bus.Connector.prototype.send_async = function() {
  setTimeout(this.send.bind(this, "emulator-ready", void 0), 0);
};
Bus.Connector.prototype.should_send = function() {
  if (!this.pair) {
    return!1;
  }
  var a = this.pair.listeners["serial0-output-line"];
  return void 0 !== a && 0 < a.length;
};
Bus.create = function() {
  var a = new Bus.Connector, c = new Bus.Connector;
  a.pair = c;
  c.pair = a;
  return[a, c];
};
[[1, ""], [2, "CPU"], [32768, "DISK"], [4, "FPU"], [8, "MEM"], [16, "DMA"], [32, "IO"], [64, "PS2"], [128, "PIC"], [256, "VGA"], [512, "PIT"], [1024, "MOUS"], [2048, "PCI"], [4096, "BIOS"], [8192, "CD"], [16384, "SERI"], [65536, "RTC"], [131072, "HPET"], [262144, "ACPI"], [524288, "APIC"], [1048576, "NET"], [2097152, "VIO"], [4194304, "9P"]].reduce(function(a, c) {
  a[c[0]] = c[1];
  return a;
}, {});
function dbg_assert() {
}
;function KeyboardAdapter(a) {
  function c(a) {
    return a.shiftKey && a.ctrlKey && 74 === a.keyCode || !l.KeyboardAdapter$emu_enabled ? !1 : a.target ? "phone_keyboard" === a.target.className || "INPUT" !== a.target.nodeName && "TEXTAREA" !== a.target.nodeName : !0;
  }
  function d(a) {
    if (c(a)) {
      var d = a.keyCode;
      if (!m[d]) {
        return!1;
      }
      m[d] = !1;
      g(d, !1) || a.preventDefault();
    }
  }
  function e(a) {
    if (c(a)) {
      var d = a.keyCode;
      m[d] && g(d, !1);
      m[d] = !0;
      g(d, !0) || a.preventDefault();
    }
  }
  function f() {
    for (var a = Object.keys(m), c, d = 0;d < a.length;d++) {
      c = +a[d], m[c] && g(c, !1);
    }
    m = {};
  }
  function g(a, c) {
    if (l.bus) {
      if (a >= n.length || 0 === n[a]) {
        return console.log("Missing char in map: " + a.toString(16)), !0;
      }
      var d = n[a];
      c || (d |= 128);
      255 < d ? (k(d >> 8), k(d & 255)) : k(d);
      return!1;
    }
  }
  function k(a) {
    l.bus.send("keyboard-code", a);
  }
  var m = {}, l = this;
  this.KeyboardAdapter$emu_enabled = !0;
  var n = new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 14, 15, 0, 0, 0, 28, 0, 0, 42, 29, 56, 0, 58, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 57, 57417, 57425, 57423, 57415, 57419, 57416, 57421, 80, 0, 0, 0, 0, 82, 83, 0, 11, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 39, 0, 13, 0, 0, 0, 30, 48, 46, 32, 18, 33, 34, 35, 23, 36, 37, 38, 50, 49, 24, 25, 16, 19, 31, 20, 22, 47, 17, 45, 21, 44, 57435, 57436, 57437, 0, 0, 82, 79, 80, 81, 75, 76, 77, 71, 72, 73, 0, 0, 0, 0, 0, 0, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 69, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 39, 13, 51, 12, 52, 53, 41, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26, 43, 27, 40, 0, 57435, 57400, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  this.bus = a;
  this.destroy = function() {
    window.removeEventListener("keyup", d, !1);
    window.removeEventListener("keydown", e, !1);
    window.removeEventListener("blur", f, !1);
  };
  this.init = function() {
    this.destroy();
    window.addEventListener("keyup", d, !1);
    window.addEventListener("keydown", e, !1);
    window.addEventListener("blur", f, !1);
  };
  this.init();
}
;function MouseAdapter(a) {
  function c(a) {
    return p.enabled && p.MouseAdapter$emu_enabled && (!a.target || "mousemove" === a.type || "INPUT" !== a.target.nodeName && "TEXTAREA" !== a.target.nodeName);
  }
  function d(a) {
    if (p.bus && c(a)) {
      var d;
      d = a.webkitMovementX || a.mozMovementX || 0;
      a = a.webkitMovementY || a.mozMovementY || 0;
      a = -(.15 * a);
      p.bus.send("mouse-delta", [.15 * d, a]);
    }
  }
  function e(a) {
    c(a) && a.preventDefault();
  }
  function f(a) {
    c(a) && k(a, !0);
  }
  function g(a) {
    c(a) && k(a, !1);
  }
  function k(a, c) {
    p.bus && (1 === a.which ? m = c : 2 === a.which ? n = c : 3 === a.which ? l = c : console.log("Unknown event.which: " + a.which), p.bus.send("mouse-click", [m, n, l]), a.preventDefault());
  }
  var m = !1, l = !1, n = !1, p = this;
  this.enabled = !1;
  this.MouseAdapter$emu_enabled = !0;
  this.bus = a;
  this.bus.register("mouse-enable", function(a) {
    this.enabled = a;
  }, this);
  this.destroy = function() {
    window.removeEventListener("mousemove", d, !1);
    document.removeEventListener("contextmenu", e, !1);
    window.removeEventListener("mousedown", f, !1);
    window.removeEventListener("mouseup", g, !1);
  };
  this.init = function() {
    this.destroy();
    window.addEventListener("mousemove", d, !1);
    document.addEventListener("contextmenu", e, !1);
    window.addEventListener("mousedown", f, !1);
    window.addEventListener("mouseup", g, !1);
  };
  this.init();
}
;function SerialAdapter(a, c) {
  function d(a) {
    g.bus && g.enabled && (g.send_char(a.keyCode), a.preventDefault());
  }
  function e(a) {
    8 === a.keyCode && (g.send_char(127), a.preventDefault());
  }
  function f(a) {
    for (var c = a.clipboardData.getData("text/plain"), d = 0;d < c.length;d++) {
      g.send_char(c.charCodeAt(d));
    }
    a.preventDefault();
  }
  var g = this;
  this.enabled = !0;
  this.bus = c;
  this.bus.register("serial0-output-char", function(a) {
    this.show_char(a);
  }, this);
  this.destroy = function() {
    a.removeEventListener("keypress", d, !1);
    a.removeEventListener("keydown", e, !1);
    a.removeEventListener("paste", f, !1);
  };
  this.init = function() {
    this.destroy();
    a.addEventListener("keypress", d, !1);
    a.addEventListener("keydown", e, !1);
    a.addEventListener("paste", f, !1);
  };
  this.init();
  this.show_char = function(c) {
    "\b" === c ? (c = a.value, a.value = c.substr(0, c.length - 1)) : "\r" !== c && (a.value += c, "\n" === c && (a.scrollTop = 1E9));
  };
  this.send_char = function(a) {
    g.bus && g.bus.send("serial0-input", a);
  };
}
;function NetworkAdapter(a, c) {
  this.bus = c;
  this.socket = void 0;
  this.send_queue = [];
  this.url = a;
  this.last_connect_attempt = Date.now() - 1E4;
  this.bus.register("net0-send", function(a) {
    this.send(a);
  }, this);
}
NetworkAdapter.prototype.handle_message = function(a) {
  this.bus && this.bus.send("net0-receive", new Uint8Array(a.data));
};
NetworkAdapter.prototype.handle_close = function() {
  this.connect();
  setTimeout(this.connect.bind(this), 1E4);
};
NetworkAdapter.prototype.handle_open = function() {
  for (var a = 0;a < this.send_queue.length;a++) {
    this.send(this.send_queue[a]);
  }
  this.send_queue = [];
};
NetworkAdapter.prototype.handle_error = function() {
};
NetworkAdapter.prototype.destroy = function() {
  this.socket && this.socket.close();
};
NetworkAdapter.prototype.connect = function() {
  if (this.socket) {
    var a = this.socket.readyState;
    if (0 === a || 1 === a) {
      return;
    }
  }
  this.last_connect_attempt + 1E4 > Date.now() || (this.last_connect_attempt = Date.now(), this.socket = new WebSocket(this.url), this.socket.binaryType = "arraybuffer", this.socket.onopen = this.handle_open.bind(this), this.socket.onmessage = this.handle_message.bind(this), this.socket.onclose = this.handle_close.bind(this), this.socket.onerror = this.handle_error.bind(this));
};
NetworkAdapter.prototype.send = function(a) {
  this.socket && 1 === this.socket.readyState ? this.socket.send(a) : (this.send_queue.push(a), 128 < this.send_queue.length && (this.send_queue = this.send_queue.slice(-64)), this.connect());
};
var v86util = v86util || {};
(function() {
  function a(a, c, d, e) {
    var l = new XMLHttpRequest;
    l.open("get", a, !0);
    l.responseType = "arraybuffer";
    if (e) {
      for (var n = Object.keys(e), p = 0;p < n.length;p++) {
        var q = n[p];
        l.setRequestHeader(q, e[q]);
      }
    }
    l.onload = function() {
      4 === l.readyState && (200 !== l.status && 206 !== l.status ? console.log("Loading the image `" + a + "` failed") : l.response && c(l.response));
    };
    d && (l.onprogress = function(a) {
      d(a);
    });
    l.send(null);
  }
  function c(a, c, d) {
    console.assert(a + c.length <= this.byteLength);
    var e = c.length;
    console.assert(0 === a % this.block_size);
    console.assert(0 === e % this.block_size);
    console.assert(e);
    a = a / this.block_size;
    for (var e = e / this.block_size, l = 0;l < e;l++) {
      var n = this.loaded_blocks[a + l];
      void 0 === n && (n = this.loaded_blocks[a + l] = new Uint8Array(this.block_size));
      var p = c.subarray(l * this.block_size, (l + 1) * this.block_size);
      n.set(p);
      console.assert(n.byteLength === p.length);
    }
    d();
  }
  function d(a, c, d) {
    this.AsyncXHRBuffer$filename = a;
    this.block_size = c;
    this.AsyncXHRBuffer$block_count = d / c;
    console.assert(this.AsyncXHRBuffer$block_count === (this.AsyncXHRBuffer$block_count | 0));
    this.loaded_blocks = {};
    this.byteLength = d;
  }
  function e(a) {
    this.AsyncFileBuffer$file = a;
    this.byteLength = a.size;
    this.block_size = 512;
    this.loaded_blocks = {};
    this.load = function() {
      this.onload && this.onload({});
    };
  }
  v86util.load_file = a;
  v86util.AsyncXHRBuffer = d;
  v86util.AsyncFileBuffer = e;
  v86util.SyncFileBuffer = function(a) {
    var c = !1, d = this;
    this.byteLength = a.size;
    1073741824 < a.size && console.log("Warning: Allocating buffer of " + (a.size >> 20) + " MB ...");
    var e = new ArrayBuffer(a.size), l = 0, n = new FileReader;
    this.load = function() {
      function p() {
        if (d.onprogress) {
          d.onprogress({loaded:l, total:a.size, lengthComputable:!0});
        }
        if (l < a.size) {
          n.readAsArrayBuffer(a.slice(l, Math.min(l + 4194304, a.size)));
        } else {
          if (c = !0, d.onload) {
            d.onload({});
          }
        }
      }
      n.onload = function(a) {
        (new Uint8Array(e, l)).set(new Uint8Array(a.target.result));
        l += 4194304;
        p();
      };
      p();
    };
    this.get = function(a, d, f) {
      if (c) {
        console.assert(a + d <= e.byteLength), f(new Uint8Array(e, a, d));
      } else {
        throw "SyncFileBuffer: Wait for ready";
      }
    };
    this.set = function(a, d, f) {
      if (c) {
        console.assert(a + d.byteLength <= e.byteLength), (new Uint8Array(e, a, d.byteLength)).set(d), f();
      } else {
        throw "SyncFileBuffer: Wait for ready";
      }
    };
  };
  d.prototype.get = function(c, d, e) {
    console.assert(0 === c % this.block_size);
    console.assert(0 === d % this.block_size);
    console.assert(d);
    a(this.AsyncXHRBuffer$filename, function(a) {
      a = new Uint8Array(a);
      this.handle_read(c, d, a);
      e(a);
    }.bind(this), null, {Range:"bytes=" + c + "-" + (c + d - 1)});
  };
  d.prototype.set = c;
  d.prototype.handle_read = function(a, c, d) {
    a = a / this.block_size;
    c = c / this.block_size;
    for (var e = 0;e < c;e++) {
      var l = this.loaded_blocks[a + e];
      l && d.set(l, e * this.block_size);
    }
  };
  e.prototype.get = function(a, c, d) {
    console.assert(0 === a % this.block_size);
    console.assert(0 === c % this.block_size);
    console.assert(c);
    var e = new FileReader;
    e.onload = function(e) {
      e = new Uint8Array(e.target.result);
      this.handle_read(a, c, e);
      d(e);
    }.bind(this);
    e.readAsArrayBuffer(this.AsyncFileBuffer$file.slice(a, a + c));
  };
  e.prototype.set = c;
  e.prototype.handle_read = d.prototype.handle_read;
})();
function V86Starter(a) {
  function c(a, c) {
    a && (a.buffer ? (console.assert(a.buffer instanceof ArrayBuffer || a.buffer instanceof File, "buffer should be ArrayBuffer or File"), c(a.buffer)) : a.url && (a.async ? c(a) : n.push({url:a.url, handler:c, size:a.size})));
  }
  function d(a, c) {
    switch(a) {
      case "hda":
        l.hda = c;
        break;
      case "hdb":
        l.hdb = c;
        break;
      case "cdrom":
        l.cdrom = c;
        break;
      case "fda":
        l.fda = c;
        break;
      case "fdb":
        l.fdb = c;
        break;
      case "bios":
        l.bios = c;
        break;
      case "vga_bios":
        l.vga_bios = c;
    }
  }
  function e(a, c) {
    if (c instanceof ArrayBuffer) {
      var e = new SyncBuffer(c)
    } else {
      c instanceof File ? e = new v86util.AsyncFileBuffer(c) : c.async ? e = new v86util.AsyncXHRBuffer(c.url, 512, c.size) : console.assert(!1);
    }
    d(a, e);
  }
  function f(c) {
    var d = n.length;
    if (c < d) {
      var e = n[c];
      v86util.load_file(e.url, function(a) {
        e.handler(a);
        f(c + 1);
      }, function(a) {
        q.emulator_bus.send("download-progress", {file_index:c, file_count:d, lengthComputable:a.lengthComputable, total:e.size || a.total, loaded:a.loaded});
      });
    } else {
      m.init(l), p && m.v86_prototype$restore_state(p), a.autostart && m.v86_prototype$run();
    }
  }
  var g = Bus.create(), k = this.bus = g[0];
  this.emulator_bus = g[1];
  var m = this.v86 = new v86(g[1]), l = {load_devices:!0};
  l.memory_size = a.memory_size || 67108864;
  l.vga_memory_size = a.vga_memory_size || 8388608;
  l.boot_order = a.boot_order || 531;
  l.fda = void 0;
  l.fdb = void 0;
  a.network_relay_url && (new NetworkAdapter(a.network_relay_url, k), l.enable_ne2k = !0);
  a.disable_keyboard || (this.keyboard_adapter = new KeyboardAdapter(k));
  a.disable_mouse || (this.mouse_adapter = new MouseAdapter(k));
  a.screen_container && (this.screen_adapter = new ScreenAdapter(a.screen_container, k));
  a.serial_container && new SerialAdapter(a.serial_container, k);
  var n = [];
  c(a.bios, d.bind(this, "bios"));
  c(a.vga_bios, d.bind(this, "vga_bios"));
  c(a.cdrom, e.bind(this, "cdrom"));
  c(a.hda, e.bind(this, "hda"));
  c(a.hdb, e.bind(this, "hdb"));
  c(a.fda, e.bind(this, "fda"));
  c(a.fdb, e.bind(this, "fdb"));
  a.filesystem && (g = new FS(a.filesystem.baseurl), l.fs9p = g, g.LoadFilesystem({basefsURL:a.filesystem.basefs}));
  var p;
  a.initial_state && c(a.initial_state, function(a) {
    p = a;
  });
  var q = this;
  f(0);
}
V86Starter.prototype.V86Starter_prototype$run = function() {
  this.v86.v86_prototype$run();
};
V86Starter.prototype.V86Starter_prototype$stop = function() {
  this.v86.v86_prototype$stop();
};
V86Starter.prototype.V86Starter_prototype$restart = function() {
  this.v86.v86_prototype$restart();
};
V86Starter.prototype.add_listener = function(a, c) {
  this.bus.register(a, c, this);
};
V86Starter.prototype.remove_listener = function(a, c) {
  this.bus.unregister(a, c);
};
V86Starter.prototype.V86Starter_prototype$restore_state = function(a) {
  this.v86.v86_prototype$restore_state(a);
};
V86Starter.prototype.V86Starter_prototype$save_state = function(a) {
  var c = this;
  setTimeout(function() {
    try {
      a(null, c.v86.v86_prototype$save_state());
    } catch (d) {
      a(d, null);
    }
  }, 0);
};
V86Starter.prototype.get_statistics = function() {
  var a = {cpu:{instruction_counter:this.v86.cpu.timestamp_counter}}, c = this.v86.cpu.devices;
  c.hda && (a.hda = c.hda.stats);
  c.cdrom && (a.cdrom = c.cdrom.stats);
  c.ps2 && (a.mouse = {enabled:c.ps2.use_mouse});
  c.vga && (a.vga = c.vga.stats);
  return a;
};
V86Starter.prototype.is_running = function() {
  return this.v86.running;
};
V86Starter.prototype.keyboard_send_scancodes = function(a) {
  for (var c = this.v86.cpu.devices.ps2, d = 0;d < a.length;d++) {
    c.kbd_send_code(a[d]);
  }
};
V86Starter.prototype.screen_make_screenshot = function() {
  this.screen_adapter && this.screen_adapter.make_screenshot();
};
V86Starter.prototype.screen_set_scale = function(a, c) {
  this.screen_adapter && this.screen_adapter.set_scale(a, c);
};
V86Starter.prototype.screen_go_fullscreen = function() {
  if (this.screen_adapter) {
    var a = document.getElementById("screen_container");
    if (a) {
      var c = a.requestFullScreen || a.webkitRequestFullscreen || a.mozRequestFullScreen || a.msRequestFullScreen;
      c && (c.call(a), (a = document.getElementsByClassName("phone_keyboard")[0]) && a.focus());
      this.lock_mouse();
    }
  }
};
V86Starter.prototype.lock_mouse = function() {
  var a = document.body, c = a.requestPointerLock || a.mozRequestPointerLock || a.webkitRequestPointerLock;
  c && c.call(a);
};
V86Starter.prototype.mouse_set_status = function(a) {
  this.mouse_adapter && (this.mouse_adapter.MouseAdapter$emu_enabled = a);
};
V86Starter.prototype.keyboard_set_status = function(a) {
  this.keyboard_adapter && (this.keyboard_adapter.KeyboardAdapter$emu_enabled = a);
};
V86Starter.prototype.serial0_send = function(a) {
  for (var c = 0;c < a.length;c++) {
    this.bus.send("serial0-input", a.charCodeAt(c));
  }
};
"undefined" !== typeof window && (window.V86Starter = V86Starter, V86Starter.prototype.run = V86Starter.prototype.V86Starter_prototype$run, V86Starter.prototype.stop = V86Starter.prototype.V86Starter_prototype$stop, V86Starter.prototype.restart = V86Starter.prototype.V86Starter_prototype$restart, V86Starter.prototype.add_listener = V86Starter.prototype.add_listener, V86Starter.prototype.remove_listener = V86Starter.prototype.remove_listener, V86Starter.prototype.restore_state = V86Starter.prototype.V86Starter_prototype$restore_state, 
V86Starter.prototype.save_state = V86Starter.prototype.V86Starter_prototype$save_state, V86Starter.prototype.get_statistics = V86Starter.prototype.get_statistics, V86Starter.prototype.is_running = V86Starter.prototype.is_running, V86Starter.prototype.keyboard_send_scancodes = V86Starter.prototype.keyboard_send_scancodes, V86Starter.prototype.screen_make_screenshot = V86Starter.prototype.screen_make_screenshot, V86Starter.prototype.screen_set_scale = V86Starter.prototype.screen_set_scale, V86Starter.prototype.screen_go_fullscreen = 
V86Starter.prototype.screen_go_fullscreen, V86Starter.prototype.lock_mouse = V86Starter.prototype.lock_mouse, V86Starter.prototype.mouse_set_status = V86Starter.prototype.mouse_set_status, V86Starter.prototype.keyboard_set_status = V86Starter.prototype.keyboard_set_status, V86Starter.prototype.serial0_send = V86Starter.prototype.serial0_send);
var S_IFDIR = 16384;
function FS(a) {
  this.inodes = [];
  this.events = [];
  this.baseurl = a;
  this.filesinloadingqueue = this.qidnumber = 0;
  this.OnLoaded = function() {
  };
  this.inodedata = {};
  this.CreateDirectory("", -1);
  this._state_skip = ["OnLoaded"];
}
FS.prototype.LoadFilesystem = function(a) {
  this.LoadFSXML(a.basefsURL);
};
FS.prototype.AddEvent = function(a, c) {
  0 == this.inodes[a].status ? c() : this.events.push({id:a, OnEvent:c});
};
FS.prototype.HandleEvent = function(a) {
  0 == this.filesinloadingqueue && (this.OnLoaded = function() {
  });
  for (var c = this.events.length - 1;0 <= c;c--) {
    this.events[c].id == a && (this.events[c].OnEvent(), this.events.splice(c, 1));
  }
};
FS.prototype.LoadFSXML = function(a) {
  LoadXMLResource(a, this.OnJSONLoaded.bind(this), function(a) {
    throw a;
  });
};
FS.prototype.OnJSONLoaded = function(a) {
  var c = JSON.parse(a).fsroot, d = this;
  setTimeout(function() {
    for (var a = 0;a < c.length;a++) {
      d.LoadRecursive(c[a], 0);
    }
    d.OnLoaded = function() {
    };
  }, 0);
};
FS.prototype.LoadRecursive = function(a, c) {
  var d = this.CreateInode();
  d.name = a.name;
  d.uid = a.uid || 0;
  d.gid = a.gid || 0;
  d.ctime = a.ctime || Math.floor(Date.now() / 1E3);
  d.mtime = a.mtime || d.ctime;
  d.atime = a.atime || d.ctime;
  d.parentid = c;
  d.mode = void 0 === a.mode ? 420 : a.mode & 511;
  d.size = a.size || 0;
  0 === a.type ? this.LoadDir(d, a.children) : (1 === a.type ? (d.mode |= 32768, d.status = 2) : (d.mode |= 40960, d.symlink = a.target), this.PushInode(d));
};
FS.prototype.LoadDir = function(a, c) {
  a.updatedir = !0;
  a.mode |= S_IFDIR;
  var d = this.inodes.length;
  this.PushInode(a);
  for (var e = 0;e < c.length;e++) {
    this.LoadRecursive(c[e], d);
  }
};
FS.prototype.LoadFile = function(a) {
  var c = this.inodes[a];
  2 == c.status && (c.status = 3, this.filesinloadingqueue++, LoadBinaryResource(this.baseurl + this.GetFullPath(c.fid), function(d) {
    d = this.inodedata[a] = new Uint8Array(d);
    c.size = d.length;
    c.status = 0;
    this.filesinloadingqueue--;
    this.HandleEvent(a);
  }.bind(this), function(a) {
    throw a;
  }));
};
FS.prototype.PushInode = function(a) {
  -1 != a.parentid ? (this.inodes.push(a), a.fid = this.inodes.length - 1, this.inodes[a.parentid].updatedir = !0, a.nextid = this.inodes[a.parentid].firstid, this.inodes[a.parentid].firstid = this.inodes.length - 1) : 0 == this.inodes.length && this.inodes.push(a);
};
function Inode(a) {
  this.updatedir = !1;
  this.nextid = this.firstid = this.parentid = -1;
  this.status = 0;
  this.name = "";
  this.minor = this.major = this.mtime = this.atime = this.ctime = this.fid = this.gid = this.uid = this.size = 0;
  this.symlink = "";
  this.mode = 493;
  this.qid = {type:0, version:0, path:a};
}
FS.prototype.CreateInode = function() {
  return new Inode(++this.qidnumber);
};
FS.prototype.CreateDirectory = function(a, c) {
  var d = this.CreateInode();
  d.name = a;
  d.parentid = c;
  d.mode = 511 | S_IFDIR;
  0 <= c && (d.uid = this.inodes[c].uid, d.gid = this.inodes[c].gid, d.mode = this.inodes[c].mode & 511 | S_IFDIR);
  d.qid.type = S_IFDIR >> 8;
  this.PushInode(d);
  return this.inodes.length - 1;
};
FS.prototype.CreateFile = function(a, c) {
  var d = this.CreateInode();
  d.name = a;
  d.parentid = c;
  d.uid = this.inodes[c].uid;
  d.gid = this.inodes[c].gid;
  d.qid.type = 128;
  d.mode = this.inodes[c].mode & 438 | 32768;
  this.PushInode(d);
  return this.inodes.length - 1;
};
FS.prototype.CreateNode = function(a, c, d, e) {
  var f = this.CreateInode();
  f.name = a;
  f.parentid = c;
  f.major = d;
  f.minor = e;
  f.uid = this.inodes[c].uid;
  f.gid = this.inodes[c].gid;
  f.qid.type = 192;
  f.mode = this.inodes[c].mode & 438;
  this.PushInode(f);
  return this.inodes.length - 1;
};
FS.prototype.CreateSymlink = function(a, c, d) {
  var e = this.CreateInode();
  e.name = a;
  e.parentid = c;
  e.uid = this.inodes[c].uid;
  e.gid = this.inodes[c].gid;
  e.qid.type = 160;
  e.symlink = d;
  e.mode = 40960;
  this.PushInode(e);
  return this.inodes.length - 1;
};
FS.prototype.OpenInode = function(a) {
  var c = this.GetInode(a);
  (c.mode & 61440) == S_IFDIR && this.FillDirectory(a);
  return 2 == c.status ? (this.LoadFile(a), !1) : !0;
};
FS.prototype.CloseInode = function(a) {
  var c = this.GetInode(a);
  4 == c.status && (-1 == c.status, delete this.inodedata[a], c.size = 0);
};
FS.prototype.Rename = function(a, c, d, e) {
  if (a == d && c == e) {
    return!0;
  }
  c = this.Search(a, c);
  if (-1 == c) {
    return!1;
  }
  var f = this.Search(d, e);
  -1 != f && this.Unlink(f);
  f = this.inodes[c];
  if (this.inodes[f.parentid].firstid == c) {
    this.inodes[f.parentid].firstid = f.nextid;
  } else {
    var g = this.FindPreviousID(c);
    this.inodes[g].nextid = f.nextid;
  }
  f.parentid = d;
  f.name = e;
  f.qid.version++;
  f.nextid = this.inodes[f.parentid].firstid;
  this.inodes[f.parentid].firstid = c;
  this.inodes[a].updatedir = !0;
  return this.inodes[d].updatedir = !0;
};
FS.prototype.Write = function(a, c, d, e) {
  var f = this.inodes[a], g = this.inodedata[a];
  !g || g.length < c + d ? (this.ChangeSize(a, Math.floor(3 * (c + d) / 2)), f.size = c + d, g = this.inodedata[a]) : f.size < c + d && (f.size = c + d);
  for (a = 0;a < d;a++) {
    g[c + a] = e();
  }
};
FS.prototype.Search = function(a, c) {
  for (var d = this.inodes[a].firstid;-1 != d;) {
    if (this.inodes[d].name == c) {
      return d;
    }
    d = this.inodes[d].nextid;
  }
  return-1;
};
FS.prototype.GetFullPath = function(a) {
  for (var c = "";0 != a;) {
    c = "/" + this.inodes[a].name + c, a = this.inodes[a].parentid;
  }
  return c.substring(1);
};
FS.prototype.FindPreviousID = function(a) {
  for (var c = this.GetInode(a), c = this.inodes[c.parentid].firstid;-1 != c && this.inodes[c].nextid != a;) {
    c = this.inodes[c].nextid;
  }
  return c;
};
FS.prototype.Unlink = function(a) {
  if (0 == a) {
    return!1;
  }
  var c = this.GetInode(a);
  if ((c.mode & 61440) == S_IFDIR && -1 != c.firstid) {
    return!1;
  }
  this.inodes[c.parentid].firstid == a ? this.inodes[c.parentid].firstid = c.nextid : (a = this.FindPreviousID(a), this.inodes[a].nextid = c.nextid);
  this.inodes[c.parentid].updatedir = !0;
  c.status = 4;
  c.nextid = -1;
  c.firstid = -1;
  c.parentid = -1;
  return!0;
};
FS.prototype.GetInode = function(a) {
  return isNaN(a) || 0 > a || a > this.inodes.length ? 0 : this.inodes[a];
};
FS.prototype.ChangeSize = function(a, c) {
  var d = this.GetInode(a), e = this.inodedata[a];
  if (c != d.size) {
    var f = this.inodedata[a] = new Uint8Array(c);
    d.size = c;
    if (e) {
      for (var d = Math.min(e.length, d.size), g = 0;g < d;g++) {
        f[g] = e[g];
      }
    }
  }
};
FS.prototype.FillDirectory = function(a) {
  var c = this.GetInode(a);
  if (c.updatedir) {
    var d = c.parentid;
    -1 == d && (d = 0);
    for (var e = 0, f = this.inodes[a].firstid;-1 != f;) {
      e += 24 + UTF8Length(this.inodes[f].name), f = this.inodes[f].nextid;
    }
    var e = e + 25 + 26, g = this.inodedata[a] = new Uint8Array(e);
    c.size = e;
    e = 0;
    e += Marshall(["Q", "d", "b", "s"], [this.MakeQid(this.inodes[a]), e + 13 + 8 + 1 + 2 + 1, this.inodes[a].mode >> 12, "."], g, e);
    e += Marshall(["Q", "d", "b", "s"], [this.MakeQid(this.inodes[d]), e + 13 + 8 + 1 + 2 + 2, this.inodes[d].mode >> 12, ".."], g, e);
    for (f = this.inodes[a].firstid;-1 != f;) {
      e += Marshall(["Q", "d", "b", "s"], [this.MakeQid(this.inodes[f]), e + 13 + 8 + 1 + 2 + UTF8Length(this.inodes[f].name), this.inodes[f].mode >> 12, this.inodes[f].name], g, e), f = this.inodes[f].nextid;
    }
    c.updatedir = !1;
  }
};
FS.prototype.PrepareCAPs = function(a) {
  a = this.GetInode(a);
  if (a.caps) {
    return a.caps.length;
  }
  a.caps = new Uint8Array(12);
  a.caps[0] = 0;
  a.caps[1] = 0;
  a.caps[2] = 0;
  a.caps[3] = 1;
  a.caps[4] = 255;
  a.caps[5] = 255;
  a.caps[6] = 255;
  a.caps[7] = 255;
  a.caps[8] = 255;
  a.caps[9] = 255;
  a.caps[10] = 255;
  a.caps[11] = 255;
  return a.caps.length;
};
FS.prototype.MakeQid = function(a) {
  return a.qid;
};
function LoadXMLResource(a, c, d) {
  var e = new XMLHttpRequest;
  e.open("GET", a, !0);
  e.onreadystatechange = function() {
    4 == e.readyState && (200 != e.status && 0 != e.status ? d("Error: Could not load XML file " + a) : c(e.responseText));
  };
  e.send(null);
}
function LoadBinaryResource(a, c, d) {
  var e = new XMLHttpRequest;
  e.open("GET", a, !0);
  e.responseType = "arraybuffer";
  e.onreadystatechange = function() {
    if (4 == e.readyState) {
      if (200 != e.status && 0 != e.status) {
        d("Error: Could not load file " + a);
      } else {
        var f = e.response;
        f ? c(f) : d("Error: No data received from: " + a);
      }
    }
  };
  e.send(null);
}
;function Marshall(a, c, d, e) {
  for (var f, g = 0, k = 0;k < a.length;k++) {
    switch(f = c[k], a[k]) {
      case "w":
        d[e++] = f & 255;
        d[e++] = f >> 8 & 255;
        d[e++] = f >> 16 & 255;
        d[e++] = f >> 24 & 255;
        g += 4;
        break;
      case "d":
        d[e++] = f & 255;
        d[e++] = f >> 8 & 255;
        d[e++] = f >> 16 & 255;
        d[e++] = f >> 24 & 255;
        d[e++] = 0;
        d[e++] = 0;
        d[e++] = 0;
        d[e++] = 0;
        g += 8;
        break;
      case "h":
        d[e++] = f & 255;
        d[e++] = f >> 8;
        g += 2;
        break;
      case "b":
        d[e++] = f;
        g += 1;
        break;
      case "s":
        var m = e, l = 0;
        d[e++] = 0;
        d[e++] = 0;
        var g = g + 2, n;
        for (n in f) {
          UnicodeToUTF8Stream(f.charCodeAt(n)).forEach(function(a) {
            d[e++] = a;
            g += 1;
            l++;
          });
        }
        d[m + 0] = l & 255;
        d[m + 1] = l >> 8 & 255;
        break;
      case "Q":
        Marshall(["b", "w", "d"], [f.type, f.version, f.path], d, e), e += 13, g += 13;
    }
  }
  return g;
}
function Unmarshall2(a, c) {
  for (var d = [], e = 0;e < a.length;e++) {
    switch(a[e]) {
      case "w":
        var f = c(), f = f + (c() << 8), f = f + (c() << 16), f = f + (c() << 24 >>> 0);
        d.push(f);
        break;
      case "d":
        f = c();
        f += c() << 8;
        f += c() << 16;
        f += c() << 24 >>> 0;
        c();
        c();
        c();
        c();
        d.push(f);
        break;
      case "h":
        f = c();
        d.push(f + (c() << 8));
        break;
      case "b":
        d.push(c());
        break;
      case "s":
        for (var f = c(), f = f + (c() << 8), g = "", k = new UTF8StreamToUnicode, m = 0;m < f;m++) {
          var l = k.Put(c());
          -1 != l && (g += String.fromCharCode(l));
        }
        d.push(g);
    }
  }
  return d;
}
;function UTF8StreamToUnicode() {
  this.UTF8StreamToUnicode$stream = new Uint8Array(5);
  this.ofs = 0;
  this.Put = function(a) {
    this.UTF8StreamToUnicode$stream[this.ofs] = a;
    this.ofs++;
    switch(this.ofs) {
      case 1:
        if (128 > this.UTF8StreamToUnicode$stream[0]) {
          return this.ofs = 0, this.UTF8StreamToUnicode$stream[0];
        }
        break;
      case 2:
        if (192 == (this.UTF8StreamToUnicode$stream[0] & 224) && 128 == (this.UTF8StreamToUnicode$stream[1] & 192)) {
          return this.ofs = 0, (this.UTF8StreamToUnicode$stream[0] & 31) << 6 | this.UTF8StreamToUnicode$stream[1] & 63;
        }
      ;
    }
    return-1;
  };
}
function UnicodeToUTF8Stream(a) {
  if (128 > a) {
    return[a];
  }
  if (2048 > a) {
    return[192 | a >> 6 & 31, 128 | a & 63];
  }
}
function UTF8Length(a) {
  for (var c = 0, d = 0;d < a.length;d++) {
    c += 128 > a.charCodeAt(d) ? 1 : 2;
  }
  return c;
}
;})();
