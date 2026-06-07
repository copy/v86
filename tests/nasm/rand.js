// From http://baagoe.com/en/RandomMusings/javascript/
// Johannes Baagøe <baagoe@baagoe.com>, 2010
function Mash() {
  var n = 0xefc8249d;

  var mash = function(data) {
    data = data.toString();
    for(var i = 0; i < data.length; i++) {
      n += data.charCodeAt(i);
      var h = 0.02519603282416938 * n;
      n = h >>> 0;
      h -= n;
      h *= n;
      n = h >>> 0;
      h -= n;
      n += h * 0x100000000; // 2^32
    }
    return (n >>> 0) * 2.3283064365386963e-10; // 2^-32
  };

  return mash;
}

// From http://baagoe.com/en/RandomMusings/javascript/
export default function KISS07() {
  return (function(args) {
    // George Marsaglia, 2007-06-23
    //http://groups.google.com/group/comp.lang.fortran/msg/6edb8ad6ec5421a5
    var x = 123456789;
    var y = 362436069;
    var z =  21288629;
    var w =  14921776;
    var c = 0;

    if(args.length === 0) {
      args = [+new Date];
    }
    var mash = Mash();
    for(var i = 0; i < args.length; i++) {
      x ^= mash(args[i]) * 0x100000000; // 2^32
      y ^= mash(args[i]) * 0x100000000;
      z ^= mash(args[i]) * 0x100000000;
      w ^= mash(args[i]) * 0x100000000;
    }
    if(y === 0) {
      y = 1;
    }
    c ^= z >>> 31;
    z &= 0x7fffffff;
    if((z % 7559) === 0) {
      z++;
    }
    w &= 0x7fffffff;
    if((w % 7559) === 0) {
      w++;
    }
    mash = null;

    var int32 = function() {
      var t;

      x += 545925293;
      x >>>= 0;

      y ^= y << 13;
      y ^= y >>> 17;
      y ^= y << 5;

      t = z + w + c;
      z = w;
      c = t >>> 31;
      w = t & 0x7fffffff;

      return x + y + w | 0;
    };
    var uint32 = function() {
      var t;

      x += 545925293;
      x >>>= 0;

      y ^= y << 13;
      y ^= y >>> 17;
      y ^= y << 5;

      t = z + w + c;
      z = w;
      c = t >>> 31;
      w = t & 0x7fffffff;

      return x + y + w >>> 0;
    };

    return {
        int32,
        uint32,
    };
  } (Array.prototype.slice.call(arguments)));
}
