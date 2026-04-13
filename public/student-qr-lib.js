(function (root) {
  'use strict';

  var MODE_8BIT_BYTE = 4;
  var PAD0 = 0xEC;
  var PAD1 = 0x11;
  var G15 = 0x0537;
  var G18 = 0x1F25;
  var G15_MASK = 0x5412;
  var PATTERN_POSITION_TABLE = [
    [],
    [6, 18],[6, 22],[6, 26],[6, 30],[6, 34],[6, 22, 38],[6, 24, 42],[6, 26, 46],[6, 28, 50],
    [6, 30, 54],[6, 32, 58],[6, 34, 62],[6, 26, 46, 66],[6, 26, 48, 70],[6, 26, 50, 74],[6, 30, 54, 78],
    [6, 30, 56, 82],[6, 30, 58, 86],[6, 34, 62, 90],[6, 28, 50, 72, 94],[6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],[6, 28, 54, 80, 106],[6, 32, 58, 84, 110],[6, 30, 58, 86, 114],[6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],[6, 30, 54, 78, 102, 126],[6, 26, 52, 78, 104, 130],[6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],[6, 30, 58, 86, 114, 142],[6, 34, 62, 90, 118, 146],[6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],[6, 28, 54, 80, 106, 132, 158],[6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],[6, 30, 58, 86, 114, 142, 170]
  ];
  var RS_BLOCK_TABLE = [
    [1,26,19],[1,26,16],[1,26,13],[1,26,9],
    [1,44,34],[1,44,28],[1,44,22],[1,44,16],
    [1,70,55],[1,70,44],[2,35,17],[2,35,13],
    [1,100,80],[2,50,32],[2,50,24],[4,25,9],
    [1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],
    [2,86,68],[4,43,27],[4,43,19],[4,43,15],
    [2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],
    [2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],
    [2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],
    [2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],
    [4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],
    [2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],
    [4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],
    [3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],
    [5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],
    [5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],
    [1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],
    [5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],
    [3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],
    [3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],
    [4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],
    [2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],
    [4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],
    [6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],
    [8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],
    [10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],
    [8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],
    [3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],
    [7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],
    [5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],
    [13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],
    [17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],
    [17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],
    [13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],
    [12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],
    [6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],
    [17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],
    [4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],
    [20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],
    [19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]
  ];
  var MODE_SIZE_SMALL = { 4: 8 };
  var MODE_SIZE_MEDIUM = { 4: 16 };
  var MODE_SIZE_LARGE = { 4: 16 };
  var RS_BLOCK_OFFSET = { 1: 0, 0: 1, 3: 2, 2: 3 };

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(String(str || '')));
    str = String(str || '');
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF) {
        i++;
        var c2 = str.charCodeAt(i);
        var cp = 0x10000 + (((c & 0x3FF) << 10) | (c2 & 0x3FF));
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  function QR8bitByte(data) {
    this.mode = MODE_8BIT_BYTE;
    this.data = utf8Bytes(data);
  }
  QR8bitByte.prototype = {
    getLength: function () { return this.data.length; },
    write: function (buffer) {
      for (var i = 0; i < this.data.length; i++) buffer.put(this.data[i], 8);
    }
  };

  function BitBuffer() {
    this.buffer = [];
    this.length = 0;
  }
  BitBuffer.prototype = {
    get: function (index) {
      var bufIndex = Math.floor(index / 8);
      return ((this.buffer[bufIndex] >>> (7 - index % 8)) & 1) === 1;
    },
    put: function (num, length) {
      for (var i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
    },
    putBit: function (bit) {
      var bufIndex = Math.floor(this.length / 8);
      if (this.buffer.length <= bufIndex) this.buffer.push(0);
      if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
      this.length++;
    }
  };

  var QRMath = {
    EXP_TABLE: new Array(256),
    LOG_TABLE: new Array(256),
    glog: function (n) {
      if (n < 1) throw new Error('glog(' + n + ')');
      return QRMath.LOG_TABLE[n];
    },
    gexp: function (n) {
      while (n < 0) n += 255;
      while (n >= 256) n -= 255;
      return QRMath.EXP_TABLE[n];
    }
  };
  for (var i = 0; i < 8; i++) QRMath.EXP_TABLE[i] = 1 << i;
  for (i = 8; i < 256; i++) QRMath.EXP_TABLE[i] = QRMath.EXP_TABLE[i - 4] ^ QRMath.EXP_TABLE[i - 5] ^ QRMath.EXP_TABLE[i - 6] ^ QRMath.EXP_TABLE[i - 8];
  for (i = 0; i < 255; i++) QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;

  function QRPolynomial(num, shift) {
    if (!num || !num.length) throw new Error('bad polynomial');
    var offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    this.num = num.slice(offset);
    while (shift-- > 0) this.num.push(0);
  }
  QRPolynomial.prototype = {
    get: function (index) { return this.num[index]; },
    getLength: function () { return this.num.length; },
    multiply: function (e) {
      var num = new Array(this.getLength() + e.getLength() - 1);
      for (var k = 0; k < num.length; k++) num[k] = 0;
      for (var i = 0; i < this.getLength(); i++) {
        for (var j = 0; j < e.getLength(); j++) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
        }
      }
      return new QRPolynomial(num, 0);
    },
    mod: function (e) {
      if (this.getLength() - e.getLength() < 0) return this;
      var ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
      var num = this.num.slice();
      for (var i = 0; i < e.getLength(); i++) num[i] ^= QRMath.gexp(QRMath.glog(e.get(i)) + ratio);
      return new QRPolynomial(num, 0).mod(e);
    }
  };

  function getRSBlocks(typeNumber, errorCorrectLevel) {
    var rsBlock = RS_BLOCK_TABLE[(typeNumber - 1) * 4 + RS_BLOCK_OFFSET[errorCorrectLevel]];
    if (!rsBlock) throw new Error('bad rs block @ version:' + typeNumber + '/ec:' + errorCorrectLevel);
    var list = [];
    for (var i = 0; i < rsBlock.length; i += 3) {
      var count = rsBlock[i], totalCount = rsBlock[i + 1], dataCount = rsBlock[i + 2];
      for (var j = 0; j < count; j++) list.push({ totalCount: totalCount, dataCount: dataCount });
    }
    return list;
  }

  function getBCHDigit(data) {
    var digit = 0;
    while (data !== 0) {
      digit++;
      data >>>= 1;
    }
    return digit;
  }

  function getBCHTypeInfo(data) {
    var d = data << 10;
    while (getBCHDigit(d) - getBCHDigit(G15) >= 0) d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15)));
    return ((data << 10) | d) ^ G15_MASK;
  }

  function getBCHTypeNumber(data) {
    var d = data << 12;
    while (getBCHDigit(d) - getBCHDigit(G18) >= 0) d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18)));
    return (data << 12) | d;
  }

  function getPatternPosition(typeNumber) {
    return PATTERN_POSITION_TABLE[typeNumber - 1];
  }

  function getMaskFunction(maskPattern) {
    switch (maskPattern) {
      case 0: return function (i, j) { return (i + j) % 2 === 0; };
      case 1: return function (i) { return i % 2 === 0; };
      case 2: return function (_, j) { return j % 3 === 0; };
      case 3: return function (i, j) { return (i + j) % 3 === 0; };
      case 4: return function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; };
      case 5: return function (i, j) { return ((i * j) % 2) + ((i * j) % 3) === 0; };
      case 6: return function (i, j) { return ((((i * j) % 2) + ((i * j) % 3)) % 2) === 0; };
      case 7: return function (i, j) { return ((((i * j) % 3) + ((i + j) % 2)) % 2) === 0; };
      default: throw new Error('bad maskPattern:' + maskPattern);
    }
  }

  function getErrorCorrectPolynomial(errorCorrectLength) {
    var a = new QRPolynomial([1], 0);
    for (var i = 0; i < errorCorrectLength; i++) a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
    return a;
  }

  function getLengthInBits(mode, typeNumber) {
    if (typeNumber < 1 || typeNumber > 40) throw new Error('typeNumber out of range');
    if (typeNumber < 10) return MODE_SIZE_SMALL[mode];
    if (typeNumber < 27) return MODE_SIZE_MEDIUM[mode];
    return MODE_SIZE_LARGE[mode];
  }

  function createBytes(buffer, rsBlocks) {
    var offset = 0;
    var maxDcCount = 0;
    var maxEcCount = 0;
    var dcdata = [];
    var ecdata = [];
    var r, dcCount, ecCount, rsPoly, rawPoly, modPoly, modIndex;

    for (r = 0; r < rsBlocks.length; r++) {
      dcCount = rsBlocks[r].dataCount;
      ecCount = rsBlocks[r].totalCount - dcCount;
      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);

      var currentDc = [];
      for (var i = 0; i < dcCount; i++) currentDc.push(0xff & buffer.buffer[i + offset]);
      offset += dcCount;

      rsPoly = getErrorCorrectPolynomial(ecCount);
      rawPoly = new QRPolynomial(currentDc, rsPoly.getLength() - 1);
      modPoly = rawPoly.mod(rsPoly);

      var currentEc = [];
      var modOffset = modPoly.getLength() - ecCount;
      for (i = 0; i < ecCount; i++) {
        modIndex = i + modOffset;
        currentEc.push(modIndex >= 0 ? modPoly.get(modIndex) : 0);
      }

      dcdata.push(currentDc);
      ecdata.push(currentEc);
    }

    var data = [];
    for (i = 0; i < maxDcCount; i++) {
      for (r = 0; r < dcdata.length; r++) if (i < dcdata[r].length) data.push(dcdata[r][i]);
    }
    for (i = 0; i < maxEcCount; i++) {
      for (r = 0; r < ecdata.length; r++) if (i < ecdata[r].length) data.push(ecdata[r][i]);
    }
    return data;
  }

  function createData(typeNumber, errorCorrectLevel, dataList) {
    var buffer = new BitBuffer();
    for (var i = 0; i < dataList.length; i++) {
      var data = dataList[i];
      buffer.put(data.mode, 4);
      buffer.put(data.getLength(), getLengthInBits(data.mode, typeNumber));
      data.write(buffer);
    }

    var rsBlocks = getRSBlocks(typeNumber, errorCorrectLevel);
    var totalDataCount = 0;
    for (i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
    var bitLimit = totalDataCount * 8;

    if (buffer.length > bitLimit) {
      throw new Error('Code length overflow. Data size (' + buffer.length + ') > size available (' + bitLimit + ')');
    }

    for (i = 0; i < Math.min(bitLimit - buffer.length, 4); i++) buffer.putBit(false);
    while (buffer.length % 8 !== 0) buffer.putBit(false);

    var bytesToFill = (bitLimit - buffer.length) / 8;
    for (i = 0; i < bytesToFill; i++) buffer.put(i % 2 === 0 ? PAD0 : PAD1, 8);

    return createBytes(buffer, rsBlocks);
  }

  function getLostPoint(modules) {
    var modulesCount = modules.length;
    var lostPoint = 0;
    var row, col, sameCount, darkCount = 0;

    for (row = 0; row < modulesCount; row++) {
      var prevColor = modules[row][0];
      sameCount = 0;
      for (col = 0; col < modulesCount; col++) {
        if (modules[row][col] === prevColor) sameCount++;
        else {
          if (sameCount >= 5) lostPoint += sameCount - 2;
          sameCount = 1;
          prevColor = modules[row][col];
        }
      }
      if (sameCount >= 5) lostPoint += sameCount - 2;
    }

    for (col = 0; col < modulesCount; col++) {
      prevColor = modules[0][col];
      sameCount = 0;
      for (row = 0; row < modulesCount; row++) {
        if (modules[row][col] === prevColor) sameCount++;
        else {
          if (sameCount >= 5) lostPoint += sameCount - 2;
          sameCount = 1;
          prevColor = modules[row][col];
        }
      }
      if (sameCount >= 5) lostPoint += sameCount - 2;
    }

    for (row = 0; row < modulesCount - 1; row++) {
      for (col = 0; col < modulesCount - 1; col++) {
        var count = 0;
        if (modules[row][col]) count++;
        if (modules[row + 1][col]) count++;
        if (modules[row][col + 1]) count++;
        if (modules[row + 1][col + 1]) count++;
        if (count === 0 || count === 4) lostPoint += 3;
      }
    }

    for (row = 0; row < modulesCount; row++) {
      for (col = 0; col < modulesCount - 10; col++) {
        if (
          modules[row][col] && !modules[row][col + 1] && modules[row][col + 2] && modules[row][col + 3] && modules[row][col + 4] &&
          !modules[row][col + 5] && modules[row][col + 6] && !modules[row][col + 7] && !modules[row][col + 8] && !modules[row][col + 9] && !modules[row][col + 10]
        ) lostPoint += 40;
        if (
          !modules[row][col] && !modules[row][col + 1] && !modules[row][col + 2] && !modules[row][col + 3] && modules[row][col + 4] &&
          !modules[row][col + 5] && modules[row][col + 6] && modules[row][col + 7] && modules[row][col + 8] && !modules[row][col + 9] && modules[row][col + 10]
        ) lostPoint += 40;
      }
    }

    for (col = 0; col < modulesCount; col++) {
      for (row = 0; row < modulesCount - 10; row++) {
        if (
          modules[row][col] && !modules[row + 1][col] && modules[row + 2][col] && modules[row + 3][col] && modules[row + 4][col] &&
          !modules[row + 5][col] && modules[row + 6][col] && !modules[row + 7][col] && !modules[row + 8][col] && !modules[row + 9][col] && !modules[row + 10][col]
        ) lostPoint += 40;
        if (
          !modules[row][col] && !modules[row + 1][col] && !modules[row + 2][col] && !modules[row + 3][col] && modules[row + 4][col] &&
          !modules[row + 5][col] && modules[row + 6][col] && modules[row + 7][col] && modules[row + 8][col] && !modules[row + 9][col] && modules[row + 10][col]
        ) lostPoint += 40;
      }
    }

    for (row = 0; row < modulesCount; row++) {
      for (col = 0; col < modulesCount; col++) if (modules[row][col]) darkCount++;
    }
    var ratio = Math.abs((100 * darkCount / modulesCount / modulesCount) - 50) / 5;
    lostPoint += Math.floor(ratio) * 10;

    return lostPoint;
  }

  function QRCodeModel(typeNumber, errorCorrectLevel) {
    this.typeNumber = typeNumber;
    this.errorCorrectLevel = errorCorrectLevel;
    this.modules = null;
    this.moduleCount = 0;
    this.dataCache = null;
    this.dataList = [];
  }
  QRCodeModel.prototype = {
    addData: function (data) {
      this.dataList.push(new QR8bitByte(data));
      this.dataCache = null;
    },
    isDark: function (row, col) {
      if (row < 0 || this.moduleCount <= row || col < 0 || this.moduleCount <= col) throw new Error(row + ',' + col);
      return !!this.modules[row][col];
    },
    getModuleCount: function () { return this.moduleCount; },
    make: function () {
      if (this.typeNumber < 1) this.typeNumber = this.getBestTypeNumber();
      this.makeImpl(false, this.getBestMaskPattern());
    },
    getBestTypeNumber: function () {
      for (var typeNumber = 1; typeNumber <= 40; typeNumber++) {
        try {
          createData(typeNumber, this.errorCorrectLevel, this.dataList);
          return typeNumber;
        } catch (e) {
          if (!/overflow/i.test(String(e && e.message || e))) throw e;
        }
      }
      throw new Error('QR 데이터가 너무 깁니다.');
    },
    makeImpl: function (test, maskPattern) {
      this.moduleCount = this.typeNumber * 4 + 17;
      this.modules = new Array(this.moduleCount);
      for (var row = 0; row < this.moduleCount; row++) {
        this.modules[row] = new Array(this.moduleCount);
        for (var col = 0; col < this.moduleCount; col++) this.modules[row][col] = null;
      }

      this.setupPositionProbePattern(0, 0);
      this.setupPositionProbePattern(this.moduleCount - 7, 0);
      this.setupPositionProbePattern(0, this.moduleCount - 7);
      this.setupPositionAdjustPattern();
      this.setupTimingPattern();
      this.setupTypeInfo(test, maskPattern);
      if (this.typeNumber >= 7) this.setupTypeNumber(test);

      if (this.dataCache == null) this.dataCache = createData(this.typeNumber, this.errorCorrectLevel, this.dataList);
      this.mapData(this.dataCache, maskPattern);
    },
    setupPositionProbePattern: function (row, col) {
      for (var r = -1; r <= 7; r++) {
        if (row + r <= -1 || this.moduleCount <= row + r) continue;
        for (var c = -1; c <= 7; c++) {
          if (col + c <= -1 || this.moduleCount <= col + c) continue;
          if ((0 <= r && r <= 6 && (c === 0 || c === 6)) || (0 <= c && c <= 6 && (r === 0 || r === 6)) || (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
            this.modules[row + r][col + c] = true;
          } else {
            this.modules[row + r][col + c] = false;
          }
        }
      }
    },
    getBestMaskPattern: function () {
      var minLostPoint = 0;
      var pattern = 0;
      for (var i = 0; i < 8; i++) {
        this.makeImpl(true, i);
        var lostPoint = getLostPoint(this.modules);
        if (i === 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }
      return pattern;
    },
    setupTimingPattern: function () {
      var r, c;
      for (r = 8; r < this.moduleCount - 8; r++) {
        if (this.modules[r][6] !== null) continue;
        this.modules[r][6] = (r % 2 === 0);
      }
      for (c = 8; c < this.moduleCount - 8; c++) {
        if (this.modules[6][c] !== null) continue;
        this.modules[6][c] = (c % 2 === 0);
      }
    },
    setupPositionAdjustPattern: function () {
      var pos = getPatternPosition(this.typeNumber);
      for (var i = 0; i < pos.length; i++) {
        for (var j = 0; j < pos.length; j++) {
          var row = pos[i], col = pos[j];
          if (this.modules[row][col] !== null) continue;
          for (var r = -2; r <= 2; r++) {
            for (var c = -2; c <= 2; c++) {
              if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) this.modules[row + r][col + c] = true;
              else this.modules[row + r][col + c] = false;
            }
          }
        }
      }
    },
    setupTypeNumber: function (test) {
      var bits = getBCHTypeNumber(this.typeNumber);
      for (var i = 0; i < 18; i++) {
        var mod = !test && (((bits >> i) & 1) === 1);
        this.modules[Math.floor(i / 3)][i % 3 + this.moduleCount - 8 - 3] = mod;
      }
      for (i = 0; i < 18; i++) {
        mod = !test && (((bits >> i) & 1) === 1);
        this.modules[i % 3 + this.moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    },
    setupTypeInfo: function (test, maskPattern) {
      var data = (this.errorCorrectLevel << 3) | maskPattern;
      var bits = getBCHTypeInfo(data);
      var i, mod;
      for (i = 0; i < 15; i++) {
        mod = !test && (((bits >> i) & 1) === 1);
        if (i < 6) this.modules[i][8] = mod;
        else if (i < 8) this.modules[i + 1][8] = mod;
        else this.modules[this.moduleCount - 15 + i][8] = mod;
      }
      for (i = 0; i < 15; i++) {
        mod = !test && (((bits >> i) & 1) === 1);
        if (i < 8) this.modules[8][this.moduleCount - i - 1] = mod;
        else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod;
        else this.modules[8][15 - i - 1] = mod;
      }
      this.modules[this.moduleCount - 8][8] = !test;
    },
    mapData: function (data, maskPattern) {
      var inc = -1;
      var row = this.moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = getMaskFunction(maskPattern);
      for (var col = this.moduleCount - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
          for (var c = 0; c < 2; c++) {
            if (this.modules[row][col - c] === null) {
              var dark = false;
              if (byteIndex < data.length) dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
              if (maskFunc(row, col - c)) dark = !dark;
              this.modules[row][col - c] = dark;
              bitIndex--;
              if (bitIndex === -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || this.moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    }
  };

  function resolveElement(el) {
    if (typeof el === 'string') return document.getElementById(el);
    return el;
  }

  function QRCode(el, options) {
    if (!(this instanceof QRCode)) return new QRCode(el, options);
    this._el = resolveElement(el);
    if (!this._el) throw new Error('QR 코드 렌더링 대상 요소를 찾을 수 없습니다.');
    this._options = {
      text: '',
      width: 256,
      height: 256,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    };
    this._applyOptions(options || {});
    if (this._options.text) this.makeCode(this._options.text);
  }

  QRCode.CorrectLevel = { L: 1, M: 0, Q: 3, H: 2 };

  QRCode.prototype._applyOptions = function (options) {
    for (var k in options) {
      if (Object.prototype.hasOwnProperty.call(options, k) && options[k] != null) this._options[k] = options[k];
    }
  };

  QRCode.prototype.clear = function () {
    if (!this._el) return;
    this._el.innerHTML = '';
  };

  QRCode.prototype.makeCode = function (text) {
    this._options.text = String(text == null ? '' : text);
    this.clear();
    if (!this._options.text) return;

    var model = new QRCodeModel(-1, this._options.correctLevel);
    model.addData(this._options.text);
    model.make();

    var count = model.getModuleCount();
    var border = 4;
    var size = Math.max(64, Math.min(4096, parseInt(this._options.width, 10) || 256));
    var height = Math.max(64, Math.min(4096, parseInt(this._options.height, 10) || size));
    var total = count + border * 2;
    var dpr = Math.max(1, root.devicePixelRatio || 1);

    var canvas = document.createElement('canvas');
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = height + 'px';

    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('캔버스 렌더링을 지원하지 않는 환경입니다.');
    ctx.imageSmoothingEnabled = false;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = this._options.colorLight;
    ctx.fillRect(0, 0, size, height);
    ctx.fillStyle = this._options.colorDark;

    var tileW = size / total;
    var tileH = height / total;
    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (!model.isDark(row, col)) continue;
        var w = Math.ceil((col + border + 1) * tileW) - Math.floor((col + border) * tileW);
        var h = Math.ceil((row + border + 1) * tileH) - Math.floor((row + border) * tileH);
        ctx.fillRect(Math.round((col + border) * tileW), Math.round((row + border) * tileH), w, h);
      }
    }

    this._el.appendChild(canvas);
  };

  root.QRCode = QRCode;
})(typeof window !== 'undefined' ? window : globalThis);
