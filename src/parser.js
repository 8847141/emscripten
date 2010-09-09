// LLVM parser
//============

/*
 * TODO:
 *    * Re-use variables (of the same kind, native/nativized vs. emulated).
 */

// Prep - allow this to run in both SpiderMonkey and V8

if (!this['load']) {
  load = function(f) { eval(snarf(f)) }
}
if (!this['read']) {
  read = function(f) { snarf(f) }
}

load('settings.js');
if (LABEL_DEBUG && RELOOP) throw "Cannot debug labels if they have been relooped!";

load('utility.js');
load('enzymatic.js');
load('snippets.js');

// Tools

// Simple #if/else/endif preprocessing for a file. Checks if the
// ident checked is true in our global.
function preprocess(text) {
  var lines = text.split('\n');
  var ret = '';
  var show = true;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line[0] != '#') {
      if (show) {
        ret += line + '\n';
      }
    } else {
      if (line[1] == 'i') { // if
        var ident = line.substr(4);
        show = !!this[ident];
      } else if (line[2] == 'l') { // else
        show = !show;
      } else if (line[2] == 'n') { // endif
        show = true;
      } else {
        throw "Unclear preprocessor command: " + line;
      }
    }
  }
  return ret;
}

function addPointing(type) { return type + '*' }
function removePointing(type, num) {
  if (num === 0) return type;
  return type.substr(0, type.length-(num ? num : 1))
}

function pointingLevels(type) {
  if (!type) return 0;
  var ret = 0;
  var len1 = type.length - 1;
  while (type[len1-ret] === '*') {
    ret ++;
  }
  return ret;
}

function toNiceIdent(ident) {
  if (parseFloat(ident) == ident) return ident;
  if (ident == 'null') return '0'; // see parseNumerical
  return ident.replace(/[" \.@%:<>,\*]/g, '_');
}

function isNumberType(type) {
  var types = ['i1', 'i8', 'i32', 'i64', 'float', 'double'];
  return types.indexOf(type) != -1;
}

function isStructPointerType(type) {
  var proof = '%struct';
  return type.substr(0, proof.length) == proof;
}

function isStructType(type) {
  if (/^\[\d+\ x\ (.*)\]/g.test(type)) return true; // [15 x ?] blocks. Like structs
  if (isPointerType(type)) return false;
  var proofs = ['%struct', '%"struct'];
  return type.substr(0, proofs[0].length) == proofs[0] ||
         type.substr(0, proofs[1].length) == proofs[1];
}

function isPointerType(type) { // TODO!
  return pointingLevels(type) > 0;
}

function isVoidType(type) {
  return type == 'void';
}

function isType(type) { // TODO!
  return isVoidType(type) || isNumberType(type) || isStructType(type) || isPointerType(type);
}

// Detects a function definition, ([...|type,[type,...]])
function isFunctionDef(token) {
  var text = token.text;
  var pointing = pointingLevels(text);
  var nonPointing = removePointing(text, pointing);
  if (nonPointing[0] != '(' || nonPointing.substr(-1) != ')')
    return false;
  if (nonPointing == '(...)') return true;
  if (!token.item) return false;
  var fail = false;
  splitTokenList(token.item[0].tokens).forEach(function(segment) {
    var subtoken = segment[0];
    fail = fail || !isType(subtoken.text);
  });
  return !fail;
}

function addIdent(token) {
  token.ident = token.text;
  return token;
}

function combineTokens(tokens) {
  var ret = {
    lineNum: tokens[0].lineNum,
    text: '',
    tokens: [],
  };
  tokens.forEach(function(token) {
    ret.text += token.text;
    ret.tokens.push(token);
  });
  return ret;
}

function compareTokens(a, b) {
  var aId = a.__uid__;
  var bId = b.__uid__;
  a.__uid__ = 0;
  b.__uid__ = 0;
  var ret = JSON.stringify(a) == JSON.stringify(b);
  a.__uid__ = aId;
  b.__uid__ = bId;
  return ret;
}

function getTokenIndexByText(tokens, text) {
  var i = 0;
  while (tokens[i].text != ';') i++;
  return i;
}

// Splits a list of tokens separated by commas. For example, a list of arguments in a function call
function splitTokenList(tokens) {
  if (tokens.length == 0) return [];
  if (tokens.slice(-1)[0].text != ',') tokens.push({text:','});
  var ret = [];
  var seg = [];
  tokens.forEach(function(token) {
    if (token.text == ',') {
      ret.push(seg);
      seg = [];
    } else {
      seg.push(token);
    }
  });
  return ret;
}

function makeSplitter(parentSlot, parentSlotValue, parentUnrequiredSlot, childSlot, copySlots) {
  return {
    selectItem: function(item) { return item[parentSlot] == parentSlotValue && !item[parentUnrequiredSlot] && item[childSlot] !== null },
    process: function(parents) {
      if (!copySlots) copySlots = [];
      var ret = parents.slice(0);
      for (var i = 0; i < parents.length; i++) {
        var parent = parents[i];
        var child = parent[childSlot];
        parent[childSlot] = null;
        child.parentUid = parent.__uid__;
        child.parentSlot = childSlot;
        child.lineNum = parent.lineNum; // Debugging
        copySlots.forEach(function(slot) { child[slot] = parent[slot] });
        ret.push(child);
      }
      return ret;
    },
  };
}

function makeCombiner(parentSlot, parentSlotValue, parentUnrequiredSlot, childRequiredSlot, finalizeFunc) {
  return {
    select: function(items) {
      var ret = [];
      var parents = items.filter(function(item) { return item[parentSlot] == parentSlotValue && !item[parentUnrequiredSlot] });
      for (var i = 0; i < parents.length; i++) {
        var parent = parents[i];
        var child = items.filter(function(item) { return item[childRequiredSlot] && item.parentUid === parent.__uid__ })[0];
        if (child) {
          ret = ret.concat([parent, child]);
        }
      }
      return ret;
    },
    process: function(items) {
      return Zyme.prototype.processPairs(items, function(parent, child) {
        parent[child.parentSlot] = child;
        delete child.parentUid;
        delete child.parentSlot;
        finalizeFunc(parent);
        return [parent];
      });
    },
  };
}

function parseParamTokens(params) {
  if (params.length === 0) return [];
  var ret = [];
  if (params[params.length-1].text != ',') {
    params.push({ text: ',' });
  }
  while (params.length > 0) {
    //print('params ' + JSON.stringify(params));
    var i = 0;
    while (params[i].text != ',') i++;
    var segment = params.slice(0, i);
    params = params.slice(i+1);
    segment = cleanSegment(segment);
    if (segment.length == 1 && segment[0].text == '...') {
      ret.push({
        intertype: 'varargs',
      });
    } else if (segment[1].text === 'getelementptr') {
      ret.push(parseGetElementPtr(segment));
    } else if (segment[1].text === 'bitcast') {
      ret.push(parseBitcast(segment));
    } else {
      if (segment[2] && segment[2].text == 'to') { // part of bitcast params
        segment = segment.slice(0, 2);
      }
      while (segment.length > 2) {
        segment[0].text += segment[1].text;
        segment.splice(1, 1); // TODO: merge tokens nicely
      }
      ret.push({
        intertype: 'value',
        type: segment[0],
        value: segment[1],
        ident: segment[1].text,
      });
      //          } else {
      //            throw "what is this params token? " + JSON.stringify(segment);
    }
  }
  return ret;
}

function cleanSegment(segment) {
  if (segment.length == 1) return segment;
  while (['noalias', 'sret', 'nocapture', 'nest', 'zeroext', 'signext'].indexOf(segment[1].text) != -1) {
    segment.splice(1, 1);
  }
  return segment;
}

// Expects one of the several LVM getelementptr formats:
// a qualifier, a type, a null, then an () item with tokens
function parseGetElementPtr(segment) {
  segment = segment.slice(0);
  segment = cleanSegment(segment);
  assertTrue(['inreg', 'byval'].indexOf(segment[1].text) == -1);
  //dprint('// zz: ' + dump(segment) + '\n\n\n');
  var ret = {
    intertype: 'getelementptr',
    type: segment[0],
    params: parseParamTokens(segment[3].item[0].tokens),
  };
  ret.ident = toNiceIdent(ret.params[0].ident);
  return ret;
}

// TODO: use this
function parseBitcast(segment) {
  //print('zz parseBC pre: ' + dump(segment));
  var ret = {
    intertype: 'bitcast',
    type: segment[0],
    params: parseParamTokens(segment[2].item[0].tokens),
  };
  ret.ident = toNiceIdent(ret.params[0].ident);
//print('zz parseBC: ' + dump(ret));
  return ret;
}

function cleanOutTokens(filterOut, tokens, index) {
  while (filterOut.indexOf(tokens[index].text) != -1) {
    tokens.splice(index, 1);
  }
}

function _HexToInt(stringy) {
  var ret = 0;
  var mul = 1;
  var base;
  for (var i = (stringy.length - 1); i >= 0; i = i - 1) {
    if (stringy.charCodeAt(i) >= "A".charCodeAt(0)) {
      base = "A".charCodeAt(0) - 10;
    } else {
      base = "0".charCodeAt(0);
    }
    ret = ret + (mul*(stringy.charCodeAt(i) - base));
    mul = mul * 16;
  }
  return ret;
}

function IEEEUnHex(stringy) {
  var a = _HexToInt(stringy.substr(2, 8));
  var b = _HexToInt(stringy.substr(10));
  var e = (a >> ((52 - 32) & 0x7ff)) - 1023;
  return ((((a & 0xfffff | 0x100000) * 1.0) / Math.pow(2,52-32)) * Math.pow(2, e)) + (((b * 1.0) / Math.pow(2, 52)) * Math.pow(2, e));
}

function parseNumerical(value, type) {
  if ((!type || type == 'double' || type == 'float') && value.substr(0,2) == '0x') {
    // Hexadecimal double value, as the llvm docs say,
    // "The one non-intuitive notation for constants is the hexadecimal form of floating point constants."
    return IEEEUnHex(value);
  }
  if (value == 'null') {
    // NULL *is* 0, in C/C++. No JS null! (null == 0 is false, etc.)
    return '0';
  }
  return value;
}

function getLabelIds(labels) {
  return labels.map(function(label) { return label.ident });
}

// =======================

// llvm => intertypes
function intertyper(data) {
  // Substrate

  substrate = new Substrate('Intertyper');

  // Input

  substrate.addItem({
    llvmText: data,
  });

  // Tools

  function findTokenText(item, text) {
    for (var i = 0; i < item.tokens.length; i++) {
      if (item.tokens[i].text == text) return i;
    }
    return -1;
  }

  // Line splitter.
  substrate.addZyme('LineSplitter', {
    selectItem: function(item) { return !!item.llvmText; },
    processItem: function(item) {
      var lines = item.llvmText.split('\n');
      var ret = [];
      var inContinual = false;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (inContinual || /^\ +to.*/g.test(line)) {
          // to after invoke
          ret.slice(-1)[0].lineText += line;
          if (/^\ +\]/g.test(line)) { // end of llvm switch
            inContinual = false;
          }
        } else {
          ret.push({
            lineText: line,
            lineNum: i + 1,
          });
          if (/^\ +switch\ .*/g.test(line)) {
            // beginning of llvm switch
            inContinual = true;
          }
        }
      }
      return ret.filter(function(item) { return item.lineText; });
    },
  });

  // Line tokenizer
  substrate.addZyme('Tokenizer', {
    selectItem: function(item) { return item.lineText; },
    processItem: function(item) {
      //print("line: " + item.lineText);
      var lineText = item.lineText + " ";
      var tokens = [];
      var tokenStart = -1;
      var indent = -1;
      var quotes = 0;
      var lastToken = null;
      var i = 0;
      // Note: '{' is not an encloser, as its use in functions is split over many lines
      var enclosers = {
        '[': 0,
        ']': '[',
        '(': 0,
        ')': '(',
        '<': 0,
        '>': '<',
      };
      function notEnclosed() {
        if (enclosers['['] > 0 || enclosers['('] > 0 || enclosers['<'] > 0)
          return false;
        return true;
      }
      var that = this;
      function tryStartToken() {
        if (tokenStart == -1 && notEnclosed() && quotes == 0) {
          //print("try START " + tokenStart + ',' + JSON.stringify(enclosers));
          tokenStart = i;
        }
      }
      function tryFinishToken(includeThis) {
        if (tokenStart >= 0 && notEnclosed() && quotes == 0) {
          //print("try finish " + tokenStart + ',' + JSON.stringify(enclosers));
          var token = {
            text: lineText.substr(tokenStart, i-tokenStart + (includeThis ? 1 : 0)),
          };
          if (token.text[0] in enclosers) {
            token.item = that.processItem({
              lineText: token.text.substr(1, token.text.length-2)
            });
            token.type = token.text[0];
          }
          if (indent == -1) {
            indent = tokenStart;
          }
          // merge certain tokens
          if ( (lastToken && lastToken.text == '%' && token.text[0] == '"' ) ||
               (lastToken && token.text.replace(/\*/g, '') == '') ) {
            lastToken.text += token.text;
          } else if (lastToken && isType(lastToken.text) && isFunctionDef(token)) {
            lastToken.text += ' ' + token.text;
          } else if (lastToken && token.text[token.text.length-1] == '}') {
            var openBrace = tokens.length-1;
            while (tokens[openBrace].text != '{') openBrace --;
            token = combineTokens(tokens.slice(openBrace+1));
            tokens.splice(openBrace, tokens.length-openBrace+1);
            tokens.push(token);
            token.type = '{';
            lastToken = token;
          } else {
            tokens.push(token);
            lastToken = token;
          }
          // print("new token: " + dump(lastToken));
          tokenStart = -1;
        }
      }
      for (; i < lineText.length; i++) {
        var letter = lineText[i];
        //print("letter: " + letter);
        switch (letter) {
          case ' ':
            tryFinishToken();
            break;
          case '"':
            tryFinishToken();
            tryStartToken();
            quotes = 1-quotes;
            break;
          case ',':
            tryFinishToken();
            if (notEnclosed() && quotes == 0) {
              tokens.push({ text: ',' });
            }
            break;
          default:
            if (letter in enclosers && quotes == 0) {
              if (typeof enclosers[letter] === 'number') {
                tryFinishToken();
                tryStartToken();
                enclosers[letter]++;
              } else {
                enclosers[enclosers[letter]]--;
                tryFinishToken(true);
              }
              //print('     post-enclosers: ' + JSON.stringify(enclosers));
            } else {
              tryStartToken();
            }
        }
      }
      return [{
        tokens: tokens,
        indent: indent,
        lineNum: item.lineNum,
      }];
    },
  });

  // Line parsers to intermediate form

  // Comment
  substrate.addZyme('Comment', {
    selectItem: function(item) { return item.tokens && item.tokens[0].text == ';' },
    processItem: function(item) { return [] },
  });
  // target
  substrate.addZyme('Target', {
    selectItem: function(item) { return item.tokens && item.tokens[0].text == 'target' },
    processItem: function(item) { return [] },
  });
  // globals: type or variable
  substrate.addZyme('Global', {
    selectItem: function(item) { return item.tokens && item.tokens.length >= 3 && item.indent === 0 && item.tokens[1].text == '=' },
    processItem: function(item) {
      if (item.tokens[2].text == 'type') {
        //dprint('type/const linenum: ' + item.lineNum + ':' + dump(item));
        var fields = [];
        if (item.tokens[3].text != 'opaque') {
          if (item.tokens[3].type == '<') // type <{ i8 }> XXX - check spec
            item.tokens[3] = item.tokens[3].item[0];
          var subTokens = item.tokens[3].tokens;
          subTokens.push({text:','});
          while (subTokens[0]) {
            var stop = 1;
            while ([','].indexOf(subTokens[stop].text) == -1) stop ++;
            fields.push(combineTokens(subTokens.slice(0, stop)).text);
            subTokens.splice(0, stop+1);
          }
        }
        return [{
        __result__: true,
          intertype: 'type',
          name_: item.tokens[0].text,
          fields: fields,
          lineNum: item.lineNum,
        }]
      } else {
        // variable
        var ident = item.tokens[0].text;
        while (item.tokens[2].text in { 'private': 0, 'constant': 0, 'appending': 0, 'global': 0, 'weak_odr': 0, 'internal': 0 })
          item.tokens.splice(2, 1);
        var ret = {
          __result__: true,
          intertype: 'globalVariable',
          ident: ident,
          type: item.tokens[2],
          lineNum: item.lineNum,
        };
        if (ident == '@llvm.global_ctors') {
          ret.ctors = [];
          var subTokens = item.tokens[3].item[0].tokens;
          splitTokenList(subTokens).forEach(function(segment) {
            ret.ctors.push(segment[1].tokens.slice(-1)[0].text);
          });
        } else {
          if (item.tokens[3].text == 'c')
            item.tokens.splice(3, 1);
          ret.value = item.tokens[3];
        }
        return [ret];
      }
    },
  });
  // function header
  substrate.addZyme('FuncHeader', {
    selectItem: function(item) { return item.tokens && item.tokens.length >= 4 && item.indent === 0 && item.tokens[0].text == 'define' &&
                                        item.tokens.slice(-1)[0].text == '{' },
    processItem: function(item) {
      item.tokens = item.tokens.filter(function(token) {
        return ['internal', 'signext', 'zeroext', 'nounwind', 'define', 'linkonce_odr', 'inlinehint', '{'].indexOf(token.text) == -1;
      });
      return [{
        __result__: true,
        intertype: 'function',
        ident: item.tokens[1].text,
        returnType: item.tokens[0],
        params: item.tokens[2],
        lineNum: item.lineNum,
      }];
    },
  });
  // label
  substrate.addZyme('Label', {
    selectItem: function(item) { return item.tokens && item.tokens.length >= 1 && item.indent === 0 && item.tokens[0].text.substr(-1) == ':' },
    processItem: function(item) {
      return [{
        __result__: true,
        intertype: 'label',
        ident: '%' + item.tokens[0].text.substr(0, item.tokens[0].text.length-1),
        lineNum: item.lineNum,
      }];
    },
  });
  // assignment
  substrate.addZyme('Assign', {
    selectItem: function(item) { return item.indent === 2 && item.tokens && item.tokens.length >= 3 && findTokenText(item, '=') >= 0 &&
                                 !item.intertype },
    processItem: function(item) {
      var opIndex = findTokenText(item, '=');
      return [{
        intertype: 'assign',
        ident: combineTokens(item.tokens.slice(0, opIndex)).text,
        value: null,
        lineNum: item.lineNum,
      }, { // Additional token, to be parsed, and later re-integrated
        indent: -1,
        tokens: item.tokens.slice(opIndex+1),
        parentLineNum: item.lineNum,
        parentSlot: 'value',
      }];
    },
  });
  // reintegration - find intermediate representation-parsed items and
  // place back in parents
  substrate.addZyme('Reintegrator', {
    select: function(items) {
      var ret = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].parentSlot && items[i].intertype) {
          for (var j = 0; j < items.length; j++) {
            if (items[j].lineNum == items[i].parentLineNum) {
              ret = ret.concat([items[j], items[i]]);
            }
          }
        }
      }
      return ret;
    },
    process: function(items) {
      return Zyme.prototype.processPairs(items, function(parent, child) {
        parent[child.parentSlot] = child;
        parent.__result__ = true;
        delete child.parentLineNum;

        // Special re-integration behaviors
        if (child.intertype == 'fastgetelementptrload') {
          parent.intertype = 'fastgetelementptrload';
        }

        return [parent];
      });
    }
  });
  // 'load'
  substrate.addZyme('Load', {
    selectItem: function(item) { return !item.intertype && item.indent === -1 && item.tokens && item.tokens.length >= 3 && item.tokens[0].text == 'load' },
    processItem: function(item) {
      item.pointerType = item.tokens[1];
      item.type = { text: removePointing(item.pointerType.text) };
      if (item.tokens[2].text != 'getelementptr') {
        item.intertype = 'load';
        item.pointer = item.tokens[2];
      } else {
        var last = getTokenIndexByText(item.tokens, ';');
        var gepTokens = item.tokens.slice(1, last); // without 'load'
        var segment = [ gepTokens[2], gepTokens[0], null ].concat(gepTokens.slice(3));
        var data = parseGetElementPtr(segment);
        item.intertype = 'fastgetelementptrload';
        item.type = data.type;
        item.params = data.params;
        item.pointer = { text: data.ident };
        item.value = data.value;
      }
      item.ident = item.pointer.text;
      return [item];
    },
  });
  // 'bitcast'
  substrate.addZyme('Bitcast', {
    selectItem: function(item) { return !item.intertype && item.indent === -1 && item.tokens && item.tokens.length >= 3 && item.tokens[0].text == 'bitcast' },
    processItem: function(item) {
      item.intertype = 'bitcast';
      item.type = item.tokens[1];
      item.ident = item.tokens[2].text;
      item.type2 = item.tokens[4];
      return [item];
    },
  });
  // 'getelementptr'
  substrate.addZyme('GEP', {
    selectItem: function(item) { return !item.intertype && item.indent === -1 && item.tokens && item.tokens.length >= 3 && item.tokens[0].text == 'getelementptr' },
    processItem: function(item) {
      var last = getTokenIndexByText(item.tokens, ';');
      var segment = [ item.tokens[1], { text: null }, null, { item: [ {
        tokens: item.tokens.slice(2, last)
      } ] } ];
      var data = parseGetElementPtr(segment);
      item.intertype = 'getelementptr';
      item.type = data.type;
      item.params = data.params;
      item.ident = data.ident;
      return [item];
    },
  });
  // 'call'
  substrate.addZyme('Call', {
    selectItem: function(item) { return item.tokens && item.tokens.length >= 3 && item.tokens[0].text == 'call' && !item.intertype },
    processItem: function(item) {
      item.intertype = 'call';
      if (['signext', 'zeroext'].indexOf(item.tokens[1].text) != -1) {
        item.tokens.splice(1, 1);
      }
      item.type = item.tokens[1];
      item.functionType = '';
      while (['@', '%'].indexOf(item.tokens[2].text[0]) == -1) {
        item.functionType += item.tokens[2].text;
        item.tokens.splice(2, 1);
      }
      item.ident = item.tokens[2].text;
      item.params = parseParamTokens(item.tokens[3].item[0].tokens);
      if (item.indent == 2) {
        // standalone call - not in assign
        item.standalone = true;
        item.__result__ = true;
      }
      return [item];
    },
  });
  // 'invoke'
  substrate.addZyme('Invoke', {
    selectItem: function(item) { return item.tokens && item.tokens.length >= 3 && item.tokens[0].text == 'invoke' && !item.intertype },
    processItem: function(item) {
      item.intertype = 'invoke';
      item.type = item.tokens[1];
      item.functionType = '';
      while (['@', '%'].indexOf(item.tokens[2].text[0]) == -1) {
        item.functionType += item.tokens[2].text;
        item.tokens.splice(2, 1);
      }
      cleanOutTokens(['alignstack', 'alwaysinline', 'inlinehint', 'naked', 'noimplicitfloat', 'noinline', 'alwaysinline attribute.', 'noredzone', 'noreturn', 'nounwind', 'optsize', 'readnone', 'readonly', 'ssp', 'sspreq'], item.tokens, 4);
      item.ident = item.tokens[2].text;
      item.params = parseParamTokens(item.tokens[3].item[0].tokens);
      item.toLabel = toNiceIdent(item.tokens[6].text);
      item.unwindLabel = toNiceIdent(item.tokens[9].text);
      if (item.indent == 2) {
        // standalone call - not in assign
        item.standalone = true;
        item.__result__ = true;
      }
      return [item];
    },
  });
  // 'alloca'
  substrate.addZyme('Alloca', {
    selectItem: function(item) { return !item.intertype && item.indent === -1 && item.tokens && item.tokens.length >= 3 && item.tokens[0].text == 'alloca' },
    processItem: function(item) {
      item.intertype = 'alloca';
      item.allocatedType = item.tokens[1];
      item.type = { text: addPointing(item.tokens[1].text) }; // type of pointer we will get
      item.type2 = { text: item.tokens[1].text }; // value we will create, and get a pointer to
      return [item];
    },
  });
  // mathops
  substrate.addZyme('Mathops', {
    selectItem: function(item) { return item.indent === -1 && item.tokens && item.tokens.length >= 3 &&
                                 ['add', 'sub', 'sdiv', 'mul', 'icmp', 'zext', 'urem', 'srem', 'fadd', 'fsub', 'fmul', 'fdiv', 'fcmp', 'uitofp', 'sitofp', 'fpext', 'fptrunc', 'fptoui', 'fptosi', 'trunc', 'sext', 'select', 'shl', 'shr', 'ashl', 'ashr', 'lshr', 'lshl', 'xor', 'or', 'and', 'ptrtoint', 'inttoptr']
                                  .indexOf(item.tokens[0].text) != -1 && !item.intertype },
    processItem: function(item) {
      item.intertype = 'mathop';
      item.op = item.tokens[0].text;
      item.variant = null;
      if (item.tokens[1].text == 'nsw') item.tokens.splice(1, 1);
      if (['icmp', 'fcmp'].indexOf(item.op) != -1) {
        item.variant = item.tokens[1].text;
        item.tokens.splice(1, 1);
      }
      item.type = item.tokens[1];
      item.ident = item.tokens[2].text;
      item.ident2 = item.tokens[4].text;
      item.ident3 = item.tokens[5] ? item.tokens[5].text : null;
      item.ident4 = item.tokens[8] ? item.tokens[8].text : null;
      //print('// zz got maptop ' + item.op + ',' + item.variant + ',' + item.ident + ',' + item.value);
      return [item];
    },
  });
  // 'store'
  substrate.addZyme('Store', {
    selectItem: function(item) { return item.indent === 2 && item.tokens && item.tokens.length >= 5 && item.tokens[0].text == 'store' &&
                                 !item.intertype },
    processItem: function(item) {
      if (item.tokens[3].text != ',') {
        assertEq(item.tokens[2].text, 'getelementptr');
        // complex input - likely getelementptr
        var commaIndex = 4;
        while (item.tokens[commaIndex].text != ',') commaIndex ++;
        return [{
          __result__: true,
          intertype: 'store',
          valueType: item.tokens[1],
          value: parseGetElementPtr(item.tokens.slice(1, commaIndex)),
          pointerType: item.tokens[commaIndex+1],
          pointer: item.tokens[commaIndex+2],
          ident: item.tokens[commaIndex+2].text,
          lineNum: item.lineNum,
        }];
      }
      return [{
        __result__: true,
        intertype: 'store',
        valueType: item.tokens[1],
        value: addIdent(item.tokens[2]),
        pointerType: item.tokens[4],
        pointer: item.tokens[5],
        ident: item.tokens[5].text,
        lineNum: item.lineNum,
      }];
    },
  });
  // 'br'
  substrate.addZyme('Branch', {
    selectItem: function(item) { return item.indent === 2 && item.tokens && item.tokens.length >= 3 && item.tokens[0].text == 'br' &&
                                 !item.intertype },
    processItem: function(item) {
      if (item.tokens[1].text == 'label') {
        return [{
          __result__: true,
          intertype: 'branch',
          label: toNiceIdent(item.tokens[2].text),
          lineNum: item.lineNum,
        }];
      } else {
        return [{
          __result__: true,
          intertype: 'branch',
          ident: item.tokens[2].text,
          labelTrue: toNiceIdent(item.tokens[5].text),
          labelFalse: toNiceIdent(item.tokens[8].text),
          lineNum: item.lineNum,
        }];
      }
    },
  });
  // 'ret'
  substrate.addZyme('Return', {
    selectItem: function(item) { return item.indent === 2 && item.tokens && item.tokens.length >= 2 && item.tokens[0].text == 'ret' &&
                                 !item.intertype },
    processItem: function(item) {
      return [{
        __result__: true,
        intertype: 'return',
        type: item.tokens[1].text,
        value: item.tokens[2] ? item.tokens[2].text : null,
        lineNum: item.lineNum,
      }];
    },
  });
  // 'switch'
  substrate.addZyme('Switch', {
    selectItem: function(item) { return item.indent === 2 && item.tokens && item.tokens.length >= 2 && item.tokens[0].text == 'switch' &&
                                 !item.intertype },
    processItem: function(item) {
      function parseSwitchLabels(item) {
        var ret = [];
        var tokens = item.item[0].tokens;
        while (tokens.length > 0) {
          ret.push({
            value: tokens[1].text,
            label: toNiceIdent(tokens[4].text),
          });
          tokens = tokens.slice(5);
        }
        return ret;
      }
      return [{
        __result__: true,
        intertype: 'switch',
        type: item.tokens[1].text,
        ident: item.tokens[2].text,
        defaultLabel: item.tokens[5].text,
        switchLabels: parseSwitchLabels(item.tokens[6]),
        lineNum: item.lineNum,
      }];
    },
  });
  // function end
  substrate.addZyme('FuncEnd', {
    selectItem: function(item) { return item.indent === 0 && item.tokens && item.tokens.length >= 1 && item.tokens[0].text == '}' && !item.intertype },
    processItem: function(item) {
      return [{
        __result__: true,
        intertype: 'functionEnd',
        lineNum: item.lineNum,
      }];
    },
  });
  // external function stub
  substrate.addZyme('External', {
    selectItem: function(item) { return item.indent === 0 && item.tokens && item.tokens.length >= 4 && item.tokens[0].text == 'declare' &&
                                 !item.intertype },
    processItem: function(item) {
      return [{
        __result__: true,
        intertype: 'functionStub',
        ident: item.tokens[2].text,
        returnType: item.tokens[1],
        params: item.tokens[3],
        lineNum: item.lineNum,
      }];
    },
  });
  // 'unreachable'
  substrate.addZyme('Unreachable', {
    selectItem: function(item) { return item.indent === 2 && item.tokens && item.tokens[0].text == 'unreachable' &&
                                 !item.intertype },
    processItem: function(item) {
      return [{
        __result__: true,
        intertype: 'unreachable',
        lineNum: item.lineNum,
      }];
    },
  });

  return substrate.solve();
}

// Analyze intertype data

VAR_NATIVE = 'native';
VAR_NATIVIZED = 'nativized';
VAR_EMULATED = 'emulated';

function cleanFunc(func) {
  func.lines = func.lines.filter(function(line) { return line.intertype !== null });
  func.labels.forEach(function(label) {
    label.lines = label.lines.filter(function(line) { return line.intertype !== null });
  });
}

function analyzer(data) {
//print('zz analaz')
  substrate = new Substrate('Analyzer');

  substrate.addItem({
    items: data,
  });

  // Sorter
  substrate.addZyme('Sorter', {
    selectItem: function(item) { return !item.sorted; },
    processItem: function(item) {
      item.items.sort(function (a, b) { return a.lineNum - b.lineNum });
      item.sorted = true;
      return [item];
    },
  });

  // Gatherer
  substrate.addZyme('Gatherer', {
    selectItem: function(item) { return item.sorted && !item.gathered; },
    processItem: function(item) {
      // Single-liners
      ['globalVariable', 'functionStub', 'type'].forEach(function(intertype) {
        var temp = splitter(item.items, function(item) { return item.intertype == intertype });
        item[intertype + 's'] = temp.splitOut;
        item.items = temp.leftIn;
      });
      // Functions & labels
      item.functions = []
      for (var i = 0; i < item.items.length; i++) {
        var subItem = item.items[i];
        if (subItem.intertype == 'function') {
          item.functions.push(subItem);
          subItem.endLineNum = null;
          subItem.lines = [];
          subItem.labels = [];
        } else if (subItem.intertype == 'functionEnd') {
          item.functions.slice(-1)[0].endLineNum = subItem.lineNum;
        } else if (subItem.intertype == 'label') {
          item.functions.slice(-1)[0].labels.push(subItem);
          subItem.lines = [];
        } else if (item.functions.slice(-1)[0].endLineNum === null) {
          // Internal line
          item.functions.slice(-1)[0].lines.push(subItem);
          item.functions.slice(-1)[0].labels.slice(-1)[0].lines.push(subItem);
        } else {
          print("ERROR: what is this? " + JSON.stringify(subItem));
        }
      }
      delete item.items;
      item.gathered = true;
      return [item];
    },
  });

  // IdentiNicer
  substrate.addZyme('Identinicer', {
    selectItem: function(item) { return item.gathered && !item.identiniced; },
    processItem: function(output) {
      walkJSON(output, function(item) {
        ['', '2', '3', '4', '5'].forEach(function(ext) {
          if (item && item['ident' + ext])
          item['ident' + ext] = toNiceIdent(item['ident' + ext]);
        });
      });
      output.identiniced = true;
      return [output];
    }
  });

  function addType(type, data) {
    if (type.length == 1) return;
    if (data.types[type]) return;
    if (['internal', 'inbounds', 'void'].indexOf(type) != -1) return;
    dprint('types', '// addType: ' + type);
    var check = /^\[(\d+)\ x\ (.*)\]$/g.exec(type);
    // 'blocks': [14 x %struct.X] etc.
    if (check) {
      var num = parseInt(check[1]);
      var subType = check[2];
      data.types[type] = {
        name_: type,
        fields: range(num).map(function() { return subType }),
        lineNum: '?',
      };
      return;
    }
    if (['['].indexOf(type) != -1) return;
    if (isNumberType(type) || isPointerType(type)) return;
    data.types[type] = {
      name_: type,
      fields: [ 'int32' ], // XXX
      flatSize: 1,
      lineNum: '?',
    };
  }

  // Typevestigator
  substrate.addZyme('Typevestigator', {
    selectItem: function(item) { return item.gathered && !item.typevestigated; },
    processItem: function(data) {
      // Convert types list to dict
      var old = data.types;
      data.types = {};
      old.forEach(function(type) { data.types[type.name_] = type });

      // Find additional types
      walkJSON(data, function(item) {
        if (!item) return;
        if (item.type) {
          addType(!item.type.text ? item.type : item.type.text, data);
        }
        if (item.type2) {
          addType(!item.type2.text ? item.type2 : item.type2.text, data);
        }
      });
      data.typevestigated = true;
      return [data];
    }
  });

  // Type analyzer
  substrate.addZyme('Type Analyzer', {
    selectItem: function(item) { return item.typevestigated && !item.typed; },
    processItem: function(item) {
      //print('zz analaz types')
      // 'fields' is the raw list of LLVM fields. However, we embed
      // child structures into parent structures, basically like C.
      // So { int, { int, int }, int } would be represented as
      // an Array of 4 ints. getelementptr on the parent would take
      // values 0, 1, 2, where 2 is the entire middle structure.
      // We also need to be careful with getelementptr to child
      // structures - we return a pointer to the same slab, just
      // a different offset. Likewise, need to be careful for
      // getelementptr of 2 (the last int) - it's real index is 4.
      // The benefit of this approach is inheritance -
      //    { { ancestor } , etc. } = descendant
      // In this case it is easy to bitcast ancestor to descendant
      // pointers - nothing needs to be done. If the ancestor were
      // a new slab, it would need some pointer to the outer one
      // for casting in that direction.
      // TODO: bitcasts of non-inheritance cases of embedding (not at start)
      var more = true;
      while (more) {
        more = false;
        values(item.types).forEach(function(type) {
          var ready = true;
          type.fields.forEach(function(field) {
            //print('// zz getT: ' + type.name_ + ' : ' + field);
            if (isStructType(field)) {
              if (!item.types[field]) {
                addType(field, item);
                ready = false;
              } else {
                if (!item.types[field].flatIndexes) {
                  ready = false;
                }
              }
            }
          });
          if (!ready) {
            more = true;
            return;
          }
          type.flatSize = 0;
          type.needsFlattening = false;
          var sizes = [];
          type.flatIndexes = type.fields.map(function(field) {
            var curr = type.flatSize;
            if (isStructType(field)) {
              dprint('types', 'type: ' + type.name_ + ' is so far of size ' + curr + ' and has ' + field + ' which is sized ' + item.types[field].flatSize);
              var size = item.types[field].flatSize;
              type.flatSize += size;
              sizes.push(size);
              type.needsFlattening = true;
            } else {
              type.flatSize ++;
            }
            return curr;
          });
          dprint('types', 'type: ' + type.name_ + ' has FINAL size of ' + type.flatSize);
          if (type.needsFlattening && dedup(sizes).length == 1) {
            type.flatFactor = sizes[0];
          }
        });
      }

      values(item.types).forEach(function(type) {
        dprint('types', 'type: ' + type.name_);// + ' : ' + JSON.stringify(type.fields));
      });
      item.typed = true;
      return [item];
    },
  });
  
  // Variable analyzer
  substrate.addZyme('Variable Analyzer', {
    selectItem: function(item) { return item.typevestigated && !item.variablized; },
    processItem: function(item) {
      item.functions.forEach(function(func) {
        func.variables = {};

        // LLVM is SSA, so we always have a single assignment/write. We care about
        // the reads/other uses.
        walkJSON(func.lines, function(item) {
//if (item && item.intertype == 'assign') print('zz assign: ' + JSON.stringify(item));
          if (item && item.intertype == 'assign' && ['alloca', 'load', 'call', 'bitcast', 'mathop', 'getelementptr', 'fastgetelementptrload'].indexOf(item.value.intertype) != -1) {
//print("zz add var " + item.ident + ',' + item.intertype);
            func.variables[item.ident] = {
              ident: item.ident,
              type: item.value.type.text,
              origin: item.value.intertype,
              uses: parseInt(item.value.tokens.slice(-1)[0].item[0].tokens[0].text.split('=')[1]),
            };
          }
        });

        for (vname in func.variables) {
          var variable = func.variables[vname];

          // Whether the value itself is used. For an int, always yes. For a pointer,
          // we might never use the pointer's value - we might always just store to it /
          // read from it. If so, then we can optimize away the pointer.
          variable.hasValueTaken = false;
          // Whether our address was used. If not, then we do not need to bother with
          // implementing this variable in a way that other functions can access it.
          variable.hasAddrTaken = false;

          variable.pointingLevels = pointingLevels(variable.type);

          // Analysis!

          if (variable.pointingLevels > 0) {
            // Pointers
            variable.loads = 0;
            variable.stores = 0;

            func.lines.forEach(function(line) {
              //print(dump(line))
              if (line.intertype == 'store' && line.ident == vname) {
                variable.stores ++;
              } else if ((line.intertype == 'assign' && line.value.intertype == 'load' && line.value.ident == vname) ||
                         (line.intertype == 'fastgetelementptrload' && line.ident == vname)) {
                variable.loads ++;
              }
            });

            variable.otherUses = variable.uses - variable.loads - variable.stores;
            if (variable.otherUses > 0)
              variable.hasValueTaken = true;
          }
 
          // Decision time

          if (variable.origin == 'getelementptr') {
            // Use our implementation that emulates pointers etc.
            variable.impl = VAR_EMULATED;
          } else if ( variable.pointingLevels === 0 && !variable.hasAddrTaken ) {
            // A simple int value, can be implemented as a native variable
            variable.impl = VAR_NATIVE;
          } else if ( variable.pointingLevels === 1 && variable.origin === 'alloca' && !isStructPointerType(variable.type) && !variable.hasAddrTaken && !variable.hasValueTaken ) {
            // A pointer to a value which is only accessible through this pointer. Basically
            // a local value on the stack, which nothing fancy is done on. So we can
            // optimize away the pointing altogether, and just have a native variable
            variable.impl = VAR_NATIVIZED;
          } else {
            variable.impl = VAR_EMULATED;
          }
          //print('// var ' + vname + ': ' + JSON.stringify(variable));
        }
      });
      item.variablized = true;
      return [item];
    },
  });

  // ReLooper - reconstruct nice loops, as much as possible
  substrate.addZyme('Relooper', {
    selectItem: function(item) { return item.variablized && !item.relooped },
    processItem: function(item) {
      function finish() {
        item.relooped = true;
        return [item];
      }

      // Tools

      function replaceLabels(line, labelId, toLabelId) {
        //print('// XXX replace ' + labelId + ' with ' + toLabelId);
        function process(item) {
          ['label', 'labelTrue', 'labelFalse', 'toLabel', 'unwindLabel', 'defaultLabel'].forEach(function(id) {
            if (item[id] && item[id] == labelId) {
              item[id] = toLabelId;
              //print('    replaced!');
            }
          });
        }
        if (['branch', 'invoke'].indexOf(line.intertype) != -1) {
          process(line);
        } else if (line.intertype == 'switch') {
          process(line);
          line.switchLabels.forEach(process);
        }
      }

      function replaceLabelLabels(label, labelId, toLabelId) {
        label.lines.forEach(function(line) { replaceLabels(line, labelId, toLabelId) });
        return label;
      }

      function replaceInLabels(labels, toReplace, replaceWith) {
        //print('// XXX replaceIn ' + toReplace + ' with ' + replaceWith);
        assertEq(!replaceWith || toReplace.length == 1, true); // TODO: implement other case
        labels.forEach(function(label) {
          ['inLabels'].forEach(function(l) {
            label[l] = label[l].map(function(labelId) { return toReplace.indexOf(labelId) == -1 ? labelId : replaceWith})
                               .filter(function(labelId) { return !!labelId });
          });
        });
        return labels;
      }

      function calcLabelBranchingData(labels, labelsDict) {
        item.functions.forEach(function(func) {
          labels.forEach(function(label) {
            label.outLabels = [];
            label.inLabels = [];
            label.hasReturn = false;
            label.hasBreak = false;
          });
        });
        // Find direct branchings
        labels.forEach(function(label) {
          dprint('find direct branchings at label: ' + label.ident + ':' + label.inLabels + ':' + label.outLabels);
          label.lines.forEach(function(line) {
            function process(item) {
              ['label', 'labelTrue', 'labelFalse', 'toLabel', 'unwindLabel'].forEach(function(id) {
                if (item[id]) {
                  if (item[id][0] == 'B') { // BREAK, BCONT, BNOPP
                    label.hasBreak = true;
                  } else {
                    label.outLabels.push(item[id]);
                    labelsDict[item[id]].inLabels.push(label.ident);
                  }
                }
              });
            }
            if (['branch', 'invoke'].indexOf(line.intertype) != -1) {
              process(line);
            } else if (line.intertype == 'switch') {
              process(line);
              line.switchLabels.forEach(process);
            }

            label.hasReturn |= line.intertype == 'return';
          });
        });
        // Find all incoming and all outgoing - recursively
        labels.forEach(function(label) {
          label.allInLabels = [];
          label.allOutLabels = [];
          //! MustGetTo ignores return - |if (x) return; else Y| must get to Y.
          label.mustGetHere = [];
        });

        var worked = true;
        while (worked) {
          worked = false;
          labels.forEach(function(label) {
            //print('zz at label: ' + label.ident + ':' + label.inLabels + ':' + label.outLabels);
            function inout(s, l) {
              var temp = label[s].slice(0);
              label[s].forEach(function(label2Id) {
                temp = temp.concat(labelsDict[label2Id][l]);
              });
              temp = dedup(temp);
              temp.sort();
              if (JSON.stringify(label[l]) != JSON.stringify(temp)) {
                //print('zz noticed ' + label.ident + ' ? ' + s + ',' + l + ' : ' + label[s] + ' | ' + label[l]);
                label[l] = temp;
                worked = true;
              }
            }
            inout('inLabels', 'allInLabels');
            inout('outLabels', 'allOutLabels');
          });
        }

        // Find all mustGetTos
        labels.forEach(function(label) {
          //print('path for: ' + label.ident + ',' + dump(label));
          function walk(path, label) {
            //print('path is: ' + getLabelIds(path.concat([label])));
            // If all we are is a break/return - then stop here. Otherwise, continue to other path
            //print('??? ' + label.hasReturn + ' : ' + label.hasBreak + ' : ' + label.outLabels.length);
            if (label.hasReturn || (label.hasBreak && label.outLabels.length == 0)) {
              //print('path done.');
              return [path.concat([label])]
            };
            if (path.indexOf(label) != -1) {
              //print('looping path - abort it.');
              return []; // loop - drop this path
            }
            path = path.concat([label]);
            return label.outLabels.map(function(outLabelId) { return walk(path, labelsDict[outLabelId]) })
                        .reduce(function(a, b) { return a.concat(b) }, [])
                        .filter(function(path) { return path.length > 0 });
          }
          var paths = walk([], label).map(function(path) { return getLabelIds(path) });
          //print('XXX paths: ' + JSON.stringify(paths));
          var possibles = dedup(paths.reduce(function(a,b) { return a.concat(b) }, []));
          label.mustGetTo = possibles.filter(function(possible) {
            return paths.filter(function(path) { return path.indexOf(possible) == -1 }) == 0;
          }).filter(function(possible) { return possible != label.ident });
          //print('XXX must get to: ' + JSON.stringify(label.mustGetTo));
        });

        labels.forEach(function(label) {
          label.mustGetTo.forEach(function (mustGetTo) {
            labelsDict[mustGetTo].mustGetHere.push(label.ident);
          });
        });

        if (dcheck('labelbranching')) {
          labels.forEach(function(label) {
            print('// label: ' + label.ident + ' :out      : ' + JSON.stringify(label.outLabels));
            print('//        ' + label.ident + ' :in       : ' + JSON.stringify(label.inLabels));
            print('//        ' + label.ident + ' :ALL out  : ' + JSON.stringify(label.allOutLabels));
            print('//        ' + label.ident + ' :ALL in   : ' + JSON.stringify(label.allInLabels));
            print('// ZZZZZZ ' + label.ident + ' must get to all of ' + JSON.stringify(label.mustGetTo));
          });
        }
      }

/* // Disabled merging as it seems it just removes a return now and then.
        function mergeLabels(label1Ident, label2Ident) {
          var label1 = func.labelsDict[label1Ident];
          var label2 = func.labelsDict[label2Ident];
          label1.lines.pop();
          label1.lines = label1.lines.concat(label2.lines);
          label1.outLabels = label2.outLabels;
          label2.lines = null;
          func.labels = func.labels.filter(function(label) { return !!label.lines });
print('// zz Merged away! ' + label2.ident + ' into ' + label1.ident);
          delete func.labelsDict[label2.ident];
          replaceInLabels(func.labels, [label2.ident], label1.ident);
        }
//print('Labels pre merge : ' + getLabelIds(func.labels));

        // Merge trivial labels
        var worked = true;
        while (worked) {
          worked = false;
          func.labels.forEach(function(label) {
            if (label.lines === null) return; // We were deleted
//print("// Consider: " + label.ident + ' : out/in: ' + label.outLabels.length + ',' + label.inLabels.length);// + dump(label.lines.slice(-1)[0]));
            if (label.outLabels.length == 1 &&
                label.lines.slice(-1)[0].intertype == 'branch' &&
//                label.lines.slice(-1)[0].label && // nonconditional branch
                label.lines.slice(-1)[0].label == label.outLabels[0] &&
                func.labelsDict[label.outLabels[0]].inLabels.length == 1) {
//print("// and target: " + func.labelsDict[label.outLabels[0]].inLabels);
              mergeLabels(label.ident, label.outLabels[0]);
              worked = true;
            }
          });
        }
*/

      // 'block': A self-enclosed part of the program, for example a loop or an if
      function makeBlock(labels, entry, labelsDict) {
        var def = {
          type: 'emulated', // a block we cannot map to a nicer structure like a loop. We emulate it with a barbaric switch
          labels: labels,
          entry: entry,
        };
        if (!RELOOP) return def;

        if (!entry) {
          assertTrue(labels.length == 0);
          return null; // Empty block - not even an entry
        }

        function getLastLine(block) {
          //dprint('get last line at: ' + block.labels[0].ident);
          if (block.next) return getLastLine(block.next);
          switch(block.type) {
            case 'loop':
              return getLastLine(block.rest);
            case 'if':
            case 'breakingif':
              return getLastLine(block.ifTrue);
            case 'emulated':
            case 'simple':
              if (block.labels.length == 1) {
                return block.labels[0].lines.slice(-1)[0];
              } else {
                //for (var i = 0; i < block.labels.length; i++)
                  //print('Remaining label is at line: ' + block.labels[i].lines[0].lineNum);
                return null; // throw "Not clear what the last line is."
              }
          }
        }
        function getAll(fromId, beforeIds) {
          beforeIds = beforeIds ? beforeIds : [];
          //print("//getAll : " + fromId + ' : ' + beforeIds);
          if (beforeIds && beforeIds.indexOf(fromId) != -1) return [];
          //print("getAll proceeding");
          var from = labelsDict[fromId];
          return dedup([from].concat(
            from.outLabels.map(function(outLabel) { return getAll(outLabel, beforeIds.concat(fromId)) })
                          .reduce(function(a,b) { return a.concat(b) }, [])
          ), 'ident');
        }
        function isolate(label) {
          label.inLabels = [];
          label.outLabels = [];
          return label;
        }
        dprint("\n\n// XXX MAKEBLOCK " + entry + ', num labels: ' + labels.length + ' and they are: ' + getLabelIds(labels));
        if (labels.length == 0 || !entry) {
          print('//empty labels or entry');
          return;
        }
        function forLabelLines(labels, func) {
          labels.forEach(function(label) {
            label.lines.forEach(function(line) { func(line, label) });
          });
        }

        // Begin

        calcLabelBranchingData(labels, labelsDict);

        var split = splitter(labels, function(label) { return label.ident == entry });
        var first = split.splitOut[0];
        if (!first) {
          print("//no first line");
          return;
        }
        var others = split.leftIn;
        var lastLine = first.lines.slice(-1)[0];
        dprint("//     makeBlock " + entry + ' : ' + getLabelIds(labels) + ' IN: ' + first.inLabels + '   OUT: ' + first.outLabels);
        // If we have one outgoing, and none incoming - make this a block of 1,
        // and move on the others (forgetting ourself, so they are now also
        // totally self-enclosed, once we start them)
        if (first.inLabels.length == 0 && first.outLabels.length == 1) {
          dprint('   Creating simple emulated');
          assertEq(lastLine.intertype, 'branch');
//          assertEq(!!lastLine.label, true);
          return {
            type: 'simple',
            labels: [replaceLabelLabels(first, first.outLabels[0], 'BNOPP')],
            entry: entry,
            next: makeBlock(replaceInLabels(others, entry), first.outLabels[0], labelsDict),
          };
        }
        //print('// loop ? a');
        // Looping structures - in some way, we can get back to here
        if (first.outLabels.length > 0 && first.allInLabels.indexOf(entry) != -1) {
          //print('// loop ? b');
          // Look for outsiders - labels no longer capable of getting here. Those must be
          // outside the loop. Insiders are those that can get back to the entry
          var split2 = splitter(others, function(label) { return label.allOutLabels.indexOf(entry) == -1 });
          var outsiders = split2.splitOut;
          var insiders = split2.leftIn;
          //print('//    potential loop : in/out : ' + getLabelIds(insiders) + ' to ' + getLabelIds(outsiders));
          // Hopefully exactly one of the outsiders is a 'pivot' - a label to which all those leaving
          // the loop must go. Then even some |if (falala) { ... break; }| will get ...
          // as an outsider, but it will actually still be in the loop
          var pivots =
            outsiders.filter(function(outsider) {
              return insiders.filter(function(insider) {
                return insider.mustGetTo.indexOf(outsider.ident) == -1;
              }) == 0;
            });
          // Find the earliest pivot. They must be staggered, each leading to another,
          // as all insiders must go through *all* of these. So we seek a pivot that
          // is never reached by another pivot. That must be the one with fewest
          // mustGetTo
          //print("//pivots: " + pivots.length + ',' + JSON.stringify(getLabelIds(pivots)));
          if (pivots.length >= 1) { // We have ourselves a loop
            pivots.sort(function(a, b) { return b.mustGetTo.length - a.mustGetTo.length });
            var pivot = pivots[0];
            dprint('   Creating LOOP : ' + entry + ' insiders: ' + getLabelIds(insiders) + ' to pivot: ' + pivot.ident);
            var otherLoopLabels = insiders;
            var loopLabels = insiders.concat([first]);
            var nextLabels = outsiders;
            // Rework branches out of the loop into new 'break' labels
            forLabelLines(loopLabels, function(line) {
              replaceLabels(line, pivot.ident, 'BREAK' + entry);
            });
            // Rework branches to the inc part of the loop into |continues|
            forLabelLines(loopLabels, function(line, label) {
              if (0) {// XXX - make this work :label.outLabels.length == 1 && label.outLabels[0] == entry && !label.hasBreak && !label.hasReturn) {
                      //       it can remove unneeded continues (but does too much right now, as the continue might have been
                      //       placed into an emulated while(1) switch { }
                replaceLabels(line, entry, 'BNOPP'); print("// zeezee " + line.lineNum);
              } else {
                replaceLabels(line, entry, 'BCONT' + entry);
              }
            });
            // Fix inc branch into rest
            var nextEntry = null;
            first.outLabels.forEach(function(outLabel) {
              if (outLabel != pivot.ident) {
                replaceLabels(lastLine, outLabel, 'BNOPP');
                nextEntry = outLabel;
              }
            });
            if (nextEntry == entry) { // We loop back to ourselves, the entire loop is just us
              nextEntry = null;
            }
            var ret = {
              type: 'loop',
              labels: loopLabels,
              entry: entry,
              inc: makeBlock([isolate(first)], entry, labelsDict),
              rest: makeBlock(replaceInLabels(otherLoopLabels, entry), nextEntry, labelsDict),
            };
            dprint('  getting last line for block starting with ' + entry + ' and nextEntry: ' + nextEntry);
            var lastLoopLine = getLastLine(nextEntry ? ret.rest : ret.inc);
            if (lastLoopLine) {
              replaceLabels(lastLoopLine, 'BCONT' + entry, 'BNOPP'); // Last line will feed back into the loop anyhow
            }
            ret.next = makeBlock(replaceInLabels(nextLabels, getLabelIds(loopLabels)), pivot.ident, labelsDict);
            return ret;
          }
        }

        // Try an 'if' structure
        if (first.outLabels.length == 2) {
          if (labelsDict[first.outLabels[1]].mustGetTo.indexOf(first.outLabels[0]) != -1) {
            first.outLabels.push(first.outLabels.shift()); // Reverse order - normalize. Very fast check anyhow
          }
          //print('// if? labels are ' + JSON.stringify(first.outLabels));
          if (labelsDict[first.outLabels[0]].mustGetTo.indexOf(first.outLabels[1]) != -1) {
            var ifLabelId = first.outLabels[0];
            var outLabelId = first.outLabels[1];
            // 0 - the if area. 1 - where we all exit to later
            var ifTrueLabels = getAll(ifLabelId, [outLabelId]);
            var ifLabels = ifTrueLabels.concat([first]);
            var nextLabels = getAll(outLabelId);
            // If we can get to the outside in more than 2 ways (one from if, one from True clause) - have breaks
            var breaking = labelsDict[outLabelId].allInLabels.length > 2;
            dprint('   Creating XXX IF: ' + getLabelIds(ifTrueLabels) + ' to ' + outLabelId + ' ==> ' + getLabelIds(nextLabels) + ' breaking: ' + breaking);
            //print('//   if separation: ' + labels.length + ' = ' + ifLabels.length + ' + ' + nextLabels.length + '   (' + ifTrueLabels.length + ')');
            if (breaking) {
              // Rework branches out of the if into new 'break' labels
              forLabelLines(ifTrueLabels, function(line) {
                replaceLabels(line, outLabelId, 'BREAK' + entry);
              });
            }
            // Remove branching op - we will do it manually
            replaceLabels(lastLine, ifLabelId, 'BNOPP');
            replaceLabels(lastLine, outLabelId, 'BNOPP');
            return {
              type: (breaking ? 'breaking' : '') + 'if',
              labels: ifLabels,
              entry: entry,
              ifVar: lastLine.ident,
              check: makeBlock([isolate(first)], entry, labelsDict),
              ifTrue: makeBlock(replaceInLabels(ifTrueLabels, entry), ifLabelId, labelsDict),
              next: makeBlock(replaceInLabels(nextLabels, getLabelIds(ifLabels)), outLabelId, labelsDict),
            };
          }
        }

        // Give up on this structure - emulate it
        dprint('   Creating complex emulated');
        return def;
      }

      // TODO: each of these can be run in parallel
      item.functions.forEach(function(func) {
        dprint('relooping', "// relooping function: " + func.ident);
        func.labelsDict = {};
        func.labels.forEach(function(label) {
          func.labelsDict[label.ident] = label;
        });
        func.block = makeBlock(func.labels, toNiceIdent('%entry'), func.labelsDict);
      });

      return finish();
    },
  });

  // Optimizer
  substrate.addZyme('Optimizer', {
    selectItem: function(item) { return item.relooped && !item.optimized; },
    processItem: function(item) {
      function finish() {
        item.optimized = true;
        item.__finalResult__ = true;
        return [item];
      }
      if (!OPTIMIZE) return finish();

      // Check if a line has side effects *aside* from an explicit assign if it has one
      function isLineSideEffecting(line) {
        if (line.intertype == 'assign' && line.value.intertype !== 'call') return false;
        if (['fastgetelementptrload'].indexOf(line.intertype) != -1) return false;
        return true;
      }

      function replaceVars(line, ident, replaceWith) {
        if (!replaceWith) {
          print('// Not replacing ' + dump(ident) + ' : ' + dump(replaceWith));
          return false;
        }
        var found = false;
        // assigns, loads, mathops
        var POSSIBLE_VARS = ['ident', 'ident2'];
        for (var i = 0; i < POSSIBLE_VARS.length; i++) {
          var possible = POSSIBLE_VARS[i];
          if (line[possible] == ident) {
            line[possible] = replaceWith;
            found = true;
          }
          if (line.value && line.value[possible] == ident) {
            line.value[possible] = replaceWith;
            found = true;
          }
        }
        // getelementptr, call params
        [line, line.value].forEach(function(element) {
          if (!element || !element.params) return;
          var params = element.params;
          for (var j = 0; j < params.length; j++) {
            var param = params[j];
            if (param.intertype == 'value' && param.ident == ident) {
              param.ident = replaceWith;
              found = true;
            }
          }
        });
        return found;
      }

      // Fast getelementptr loads
      item.functions.forEach(function(func) {
        for (var i = 0; i < func.lines.length-1; i++) {
          var a = func.lines[i];
          var b = func.lines[i+1];
          if (a.intertype == 'assign' && a.value.intertype == 'getelementptr' &&
              b.intertype == 'assign' && b.value.intertype == 'load' &&
              a.ident == b.value.ident) {
//            print("// LOADSUSPECT: " + i + ',' + (i+1) + ':' + a.ident + ':' + b.value.ident);
            a.intertype = 'fastgetelementptrload';
            a.ident = b.ident;
            b.intertype = null;
            i++;
          }
        }
        cleanFunc(func);
      });

      // Fast getelementptr stores
      item.functions.forEach(function(func) {
        for (var i = 0; i < func.lines.length-1; i++) {
          var a = func.lines[i];
          var b = func.lines[i+1];
          if (a.intertype == 'assign' && a.value.intertype == 'getelementptr' &&
              b.intertype == 'store' && b.value.text &&
              a.ident == b.ident) {
            //print("// STORESUSPECT: " + a.lineNum + ',' + b.lineNum);
            a.intertype = 'fastgetelementptrstore';
            a.ident = toNiceIdent(b.value.text);
            b.intertype = null;
            i++;
          }
        }
        cleanFunc(func);
      });

      // TODO: Use for all that can
      function optimizePairs(worker, minSlice, maxSlice) {
        minSlice = minSlice ? minSlice : 2;
        maxSlice = maxSlice ? maxSlice : 2;
        item.functions.forEach(function(func) {
          func.labels.forEach(function(label) {
            for (var i = 0; i < label.lines.length-1; i++) {
              for (var j = i+minSlice-1; j < Math.min(i+maxSlice+1, label.lines.length); j++) {
                if (worker(func, label.lines.slice(i, j+1))) {
                  i += j-i;
                  break; // stop working on this i
                }
              }
            }
          });
          cleanFunc(func);
        });
      }

      // Fast bitcast&something after them
      optimizePairs(function(func, lines) {
        var a = lines[0], b = lines[1];
        if (a.intertype == 'assign' && a.value.intertype == 'bitcast' && replaceVars(b, a.ident, a.value.ident)) {
          a.intertype = null;
          return true;
        }
      });

/*
      // Remove unnecessary branches
      item.functions.forEach(function(func) {
        for (var i = 0; i < func.labels.length-1; i++) {
          var a = func.labels[i].lines.slice(-1)[0];
          var b = func.labels[i+1];
          if (a.intertype == 'branch' && a.label == b.ident) {
            a.intertype = null;
          }
        }
        cleanFunc(func);
      });
*/

      // Remove temp variables around nativized
      item.functions.forEach(function(func) {
        // loads, mathops
        var worked = true;
        while (worked) {
          worked = false;
          for (var i = 0; i < func.lines.length-1; i++) {
            var a = func.lines[i];
            var b = func.lines[i+1];
            if (a.intertype == 'assign' && a.value.intertype == 'load' &&
                func.variables[a.value.ident] && // Not global
                func.variables[a.value.ident].impl === VAR_NATIVIZED) {
              //print('// ??zzzz ' + dump(a) + ',\n // ??zzbb' + dump(b));
              // If target is only used on next line - do not need it.
              if (func.variables[a.ident].uses == 1 &&
                  replaceVars(b, a.ident, a.value.ident)) {
                a.intertype = null;
                i ++;
                worked = true;
              }
            }
          }
          cleanFunc(func);
        }

        // stores
        for (var i = 0; i < func.lines.length-1; i++) {
          var a = func.lines[i];
          var b = func.lines[i+1];
          //print('// ??zzaa ' + dump(a) + ',\n // ??zzbb' + dump(b));
          if (b.intertype == 'store' &&
              func.variables[b.ident] && // Not global
              func.variables[b.ident].impl === VAR_NATIVIZED) {
            // If target is only used on prev line - do not need it.
            if (func.variables[b.value.ident] && func.variables[b.value.ident].uses == 1 &&
                ['assign', 'fastgetelementptrload'].indexOf(a.intertype) != -1 && a.ident == b.value.ident) {
              a.ident = b.ident;
              a.overrideSSA = true;
              b.intertype = null;
              i ++;
            }
          }
        }
        cleanFunc(func);
      });

      // Remove redundant vars - SLOW! XXX
      optimizePairs(function(func, lines) {
        // a - a line defining a var
        // b - a line defining a var that is identical to a
        // c - the only line using b, hopefully
        var a = lines[0], b = lines[lines.length-2], c = lines[lines.length-1];
        if (a.intertype == 'assign' && b.intertype == 'assign' &&
            func.variables[b.ident] && func.variables[b.ident].uses == 1 &&
            compareTokens(a.value, b.value) &&
            lines.slice(0,-1).filter(isLineSideEffecting).length == 0 &&
            replaceVars(c, b.ident, a.ident)) {
          b.intertype = null;
          return true;
        }
      }, 3, 12);

      return finish();
    },
  });

  return substrate.solve();
}

// Convert analyzed data to javascript
function JSify(data) {
  substrate = new Substrate('JSifyer');

  [].concat(values(data.types).filter(function(type) { return type.lineNum != '?' }))
    .concat(data.globalVariables)
    .concat(data.functions)
    .concat(data.functionStubs)
    .forEach(function(item) {
      item.passes = {};
      substrate.addItem(item);
    });

  var TYPES = data.types;

  // type
  substrate.addZyme('Type', {
    selectItem: function(item) { return item.intertype == 'type' && !item.JS },
    processItem: function(item) {
      var type = TYPES[item.name_];
      if (type.needsFlattening) {
        item.JS = 'var ' + toNiceIdent(item.name_) + '___FLATTENER = ' + JSON.stringify(TYPES[item.name_].flatIndexes) + ';';
      } else {
        item.JS = '// type: ' + item.name_;
      }
      item.__result__ = true;
      return [item];
    },
  });

  function makePointer(slab, pos) {
    // XXX hardcoded ptr impl
    if (slab == 'HEAP') return pos;
    if (slab[0] != '[') {
      slab = '[' + slab + ']';
    }
    return 'Pointer_make(' + slab + ', ' + (pos ? pos : 0) + ')';
    //    return '{ slab: ' + slab + ', pos: ' + (pos ? pos : 0) + ' }';
    //    return '[' + slab + ', ' + (pos ? pos : 0) + ']';
  }

  function makeGetSlab(ptr) {
    // XXX hardcoded ptr impl
    //    return ptr + '.slab';
    return 'HEAP';
  }

  function makeGetPos(ptr) {
    // XXX hardcoded ptr impl
    //    return ptr + '.pos';
    return ptr;
  }

  function makeGetValue(ptr, pos, noNeedFirst) {
    return makeGetSlab(ptr) + '[' + (noNeedFirst ? '0' : makeGetPos(ptr)) + (pos ? ' + ' + pos : '') + ']';
  }

  function makeSetValue(ptr, pos, value, noNeedFirst) {
    if (SAFE_HEAP) {
      return 'SAFE_HEAP_STORE(' + (noNeedFirst ? '0' : makeGetPos(ptr)) + (pos ? ' + ' + pos : '') + ', ' + value + ')';
    } else {
      return makeGetSlab(ptr) + '[' + (noNeedFirst ? '0' : makeGetPos(ptr)) + (pos ? ' + ' + pos : '') + '] = ' + value;
    }
  }

  function makeEmptyStruct(type) {
    dprint('types', '??makeemptystruct?? ' + dump(type));
    // XXX hardcoded ptr impl
    var ret = [];
    var typeData = TYPES[type];
    assertTrue(typeData);
    for (var i = 0; i < typeData.flatSize; i++) {
      ret.push(0);
    }
    return ret;
  }

  // Gets an entire constant expression
  function parseConst(value, type) {
    dprint('gconst', '//yyyyy ' + JSON.stringify(value) + ',' + type);
    if (isNumberType(type) || pointingLevels(type) == 1) {
      return makePointer(parseNumerical(value.text));
    } else if (value.text == 'zeroinitializer') {
      return makePointer(JSON.stringify(makeEmptyStruct(type)));
    } else if (value.text[0] == '"') {
      value.text = value.text.substr(1, value.text.length-2);
      return makePointer('intArrayFromString("' + value.text + '")');
    } else {
      // Gets an array of constant items, separated by ',' tokens
      function handleSegments(tokens) {
        // Handle a single segment (after comma separation)
        function handleSegment(segment) {
          //print('// seggg: ' + JSON.stringify(segment) + '\n')
          if (segment[1].text == 'null') {
            return '0';
          } else if (segment[1].text == 'zeroinitializer') {
            return JSON.stringify(makeEmptyStruct(segment[0].text));
          } else if (segment[1].text == 'getelementptr') {
            return finalizeGetElementPtr(parseGetElementPtr(segment));
          } else if (segment[1].text == 'bitcast') {
            return toNiceIdent(segment[2].item[0].tokens[1].text);
          } else if (segment[1].text in searchable('inttoptr', 'ptrtoint')) {
            var type = segment[2].item[0].tokens.slice(-1)[0].text;
            return handleSegment(segment[2].item[0].tokens.slice(0, -2));
          } else if (segment[1].text == 'add') {
            var subSegments = splitTokenList(segment[2].item[0].tokens);
            return '(' + handleSegment(subSegments[0]) + ' + ' + handleSegment(subSegments[1]) + ')';
          } else if (segment[1].type == '{') {
            return '[' + handleSegments(segment[1].tokens) + ']';
          } else if (segment.length == 2) {
            return parseNumerical(toNiceIdent(segment[1].text));
          } else {
            //print('// seggg: ' + JSON.stringify(segment) + '???!???\n')
            return '???!???';
          }
        };
        return splitTokenList(tokens).map(handleSegment).map(parseNumerical).join(', ');
      }
      if (value.item) {
        // list of items
        return makePointer('[ ' + handleSegments(value.item[0].tokens) + ' ]');
      } else if (value.type == '{') {
        // struct
        return makePointer('[ ' + handleSegments(value.tokens) + ' ]');
      } else {
        throw '// failzzzzzzzzzzzzzz ' + dump(value.item) + ' ::: ' + dump(value);
      }
    }
  }

  // globalVariablw
  substrate.addZyme('GlobalVariable', {
    selectItem: function(item) { return item.intertype == 'globalVariable' && !item.JS },
    processItem: function(item) {
      dprint('gconst', '// zz global Cons: ' + dump(item) + ' :: ' + dump(item.value));
      if (item.ident == '_llvm_global_ctors') {
        item.JS = '\n__globalConstructor__ = function() {\n' +
                    item.ctors.map(function(ctor) { return '  ' + toNiceIdent(ctor) + '();' }).join('\n') +
                  '\n}\n';
      } else if (item.type.text == 'external') {
        item.JS = 'var ' + item.ident + ' = ' + '0; /* external value? */';
      } else {
        // GETTER - lazy loading, fixes issues with ordering.
        item.JS = 'this.__defineGetter__("' + item.ident + '", function() { delete ' + item.ident + '; ' + item.ident + ' = ' + parseConst(item.value, item.type.text) + '; return ' + item.ident + ' });';
      }
      item.__result__ = true;
      return [item];
    },
  });

  // functionStub
  substrate.addZyme('FunctionStub', {
    selectItem: function(item) { return item.intertype == 'functionStub' && !item.JS },
    processItem: function(item) {
      var shortident = item.ident.substr(1);
      if (shortident in Snippets) {
        item.JS = item.ident + ' = ' + Snippets[shortident].toString();
      } else {
        item.JS = '// stub for ' + item.ident;
      }
      item.__result__ = true;
      return [item];
    },
  });

  // function splitter
  substrate.addZyme('FunctionSplitter', {
    selectItem: function(item) { return item.intertype == 'function' && !item.passes.splitted },
    processItem: function(item) {
      var ret = [item];
      item.splitItems = 0;
      item.labels.forEach(function(label) {
        label.lines.forEach(function(line) {
          line.func = item.ident;
          line.funcData = item;
          line.parentLabel = label.ident;
          ret.push(line);
          item.splitItems ++;
        });
      });

      item.passes.splitted = true;
      return ret;
    },
  });
  // function reconstructor & post-JS optimizer
  substrate.addZyme('FunctionReconstructor', {
    select: function(items) {
      var funcs = items.filter(function(item) { return item.intertype == 'function' && item.passes.splitted });
      return funcs.map(function(func) {
        var lines = items.filter(function(item) { return item.JS && item.func === func.ident });
        if (lines.length === 0) return [];
        return [func].concat(lines);
      }).reduce(concatenator, []);
    },
    process: function(allItems) {
      var ret = [];
      for (var i = 0; i < allItems.length;) {
        var func = allItems[i];
        var j = i+1;
        while (j < allItems.length && allItems[j].intertype != 'function') j++;
        var lines = allItems.slice(i+1, j);
        i = j;

        lines.forEach(function(line) {
          delete line.funcData; // clean up

          var label = func.labels.filter(function(label) { return label.ident == line.parentLabel })[0];
          label.lines = label.lines.map(function(line2) {
            return (line2.lineNum !== line.lineNum) ? line2 : line;
          });
        });

        func.splitItems -= lines.length;
        if (func.splitItems === 0) {
          postJSOptimize(func);

          // Final recombination
          //print('zz params::::: ' + JSON.stringify(func.params));
          //print('zz params::::: ' + JSON.stringify(parseParamTokens(func.params.item[0].tokens)));

          var hasVarArgs = false;
          var params = parseParamTokens(func.params.item[0].tokens).map(function(param) {
            if (param.intertype == 'varargs') {
              hasVarArgs = true;
              return null;
            }
            return toNiceIdent(param.ident);
          }).filter(function(param) { return param != null }).join(', ');

          func.JS = '\nfunction ' + func.ident + '(' + params + ') {\n';
          if (LABEL_DEBUG) func.JS += "  print(INDENT + ' Entering: " + func.ident + "'); INDENT += '  ';\n";

          // Walk function blocks and generate JS
          function walkBlock(block, indent) {
            if (!block) return '';
            function getLabelLines(label, indent) {
              var ret = '';
              if (LABEL_DEBUG) {
                ret += indent + "  print(INDENT + '" + func.ident + ":" + label.ident + "');\n";
              }
              return ret + label.lines.map(function(line) { return indent + line.JS + (line.comment ? ' // ' + line.comment : '') }).join('\n');
            }
            var ret = '';
            if (block.type == 'emulated' || block.type == 'simple') {
              if (block.labels.length > 1) {
                ret += indent + 'var __label__ = ' + getLabelId(block.entry) + '; /* ' + block.entry + ' */\n';
                ret += indent + 'while(1) switch(__label__) {\n';
                ret += block.labels.map(function(label) {
                  return indent + '  case ' + getLabelId(label.ident) + ': // ' + label.ident + '\n' + getLabelLines(label, indent + '    ');
                }).join('\n');
                ret += '\n' + indent + '}';
              } else {
                ret += getLabelLines(block.labels[0], indent);
              }
              ret += '\n';
            } else if (block.type == 'loop') {
  //            if (mustGetTo(first.outLabels[0], [first.ident, first.outLabels[1]])) { /* left branch must return here, or go to right branch */ 
              ret += indent + block.entry + ': while(1) {\n';
              ret += walkBlock(block.inc, indent + '  ');
              ret += walkBlock(block.rest, indent + '  ');
              ret += indent + '}\n';
            } else if (block.type == 'breakingif') {
              ret += walkBlock(block.check, indent);
              ret += indent + block.entry + ': do { if (' + block.ifVar + ') {\n';
              ret += walkBlock(block.ifTrue, indent + '  ');
              ret += indent + '} } while(0);\n';
            } else if (block.type == 'if') {
              ret += walkBlock(block.check, indent);
              ret += indent + 'if (' + block.ifVar + ') {\n';
              ret += walkBlock(block.ifTrue, indent + '  ');
              ret += indent + '}\n';
            } else {
              ret = 'XXXXXXXXX!';
            }
            return ret + walkBlock(block.next, indent);
          }
          func.JS += walkBlock(func.block, '  ');
          // Finalize function
          if (LABEL_DEBUG) func.JS += "  INDENT = INDENT.substr(0, INDENT.length-2);\n";
          func.JS += '}\n';
          func.__result__ = true;
        }

        ret.push(func);
      }
      return ret;
    },
  });
  function postJSOptimize(func) {
    // Some optimizations are easier to apply after JS-ing the code - for example, a lot
    // of stuff can end up as   x = y;  for example, bitcasts, or nativized, etc. If we
    // we to optimize pre-JS, we would need to be aware of all of that.
  }

  function getVarData(funcData, ident) {
    if (funcData.variables[ident]) {
      return funcData.variables[ident].impl;
    } else {
      return 'emulated'; // All global are emulated
    }
  }

  // 'assign'
  // SLOW?! XXX FIXME These two account for most of the runtime in sauer!? 34&25 seconds respectively
  substrate.addZyme('AssignSplitter', makeSplitter('intertype', 'assign', 'JS', 'value', ['funcData']));
  substrate.addZyme('AssignCombiner', makeCombiner('intertype', 'assign', 'JS', 'JS', function (item) {
    // 'var', since this is SSA - first assignment is the only assignment, and where it is defined
    item.JS = (item.overrideSSA ? '' : 'var ') + toNiceIdent(item.ident);

    var type = item.value.type.text;
    var value = parseNumerical(item.value.JS);
    //print("zz var: " + item.JS);
    var impl = getVarData(item.funcData, item.ident);
    switch (impl) {
      case VAR_NATIVE: {
        break;
      }
      case VAR_NATIVIZED: {
        // SSA, so this must be the alloca. No need for a value
        if (!item.overrideSSA) value = '';
        break;
      }
      case VAR_EMULATED: {
        break;
      }
      default: print('zz unknown impl: ' + impl);
    }
    if (value)
      item.JS += ' = ' + value;
    item.JS += ';';
/*
    if (LINEDEBUG && value) {
      item.JS += '\nprint(INDENT + "' + item.ident + ' == " + JSON.stringify(' + item.ident + '));';
      item.JS += '\nprint(INDENT + "' + item.ident + ' == " + (' + item.ident + ' && ' + item.ident + '.toString ? ' + item.ident + '.toString() : ' + item.ident + '));';
    }
*/
  }));

  // Function lines
  function makeFuncLineZyme(intertype, func) {
    substrate.addZyme('Intertype:' + intertype, {
      selectItem: function(item) { return item.intertype == intertype && !item.JS },
      processItem: function(item) {
        item.JS = func(item);
        if (!item.JS) throw "XXX - no JS generated for " + dump(item);
        return [item];
      },
    });
  }
  makeFuncLineZyme('store', function(item) {
    //print('// zzqqzz ' + dump(item.value) + ' :::: ' + dump(item.pointer) + ' :::: ');
    var ident = toNiceIdent(item.ident);
    var value;
    if (item.value.intertype == 'getelementptr') {
      value = finalizeGetElementPtr(item.value);
    } else {
      value = toNiceIdent(item.value.ident);
    }
    if (pointingLevels(item.pointerType.text) == 1) {
      value = parseNumerical(value, removePointing(item.pointerType.text));
    }
    //print("// zz seek " + ident + ',' + dump(item));
    var impl = getVarData(item.funcData, item.ident);
    var ret;
    switch (impl) {
      case VAR_NATIVIZED: ret = ident + ' = ' + value + ';'; break; // We have the actual value here
      case VAR_EMULATED: ret = makeSetValue(ident, 0, value) + ';'; break;
      default: print('zz unknown [store] impl: ' + impl);
    }
/*
    if (LINEDEBUG && value) {
      ret += '\nprint(INDENT + "' + ident + ' == " + JSON.stringify(' + ident + '));';
      ret += '\nprint(INDENT + "' + ident + ' == " + (' + ident + ' && ' + ident + '.toString ? ' + ident + '.toString() : ' + ident + '));';
    }
*/
    return ret;
  });

  var LABEL_IDs = {};
  var LABEL_ID_COUNTER = 0;
  function getLabelId(label) {
    //print('needs id: ' + label + ' : ' + JSON.stringify(LABEL_IDs));
    label = toNiceIdent(label);
    if (label in LABEL_IDs) return LABEL_IDs[label];
    return LABEL_IDs[label] = LABEL_ID_COUNTER ++;
  }

  function makeBranch(label) {
    if (label[0] == 'B') {
      if (label[1] == 'R') {
        return 'break ' + label.substr(5) + ';';
      } else if (label[1] == 'C') {
        return 'continue ' + label.substr(5) + ';';
      } else { // NOPP
        return ';'; // Returning no text might confuse this parser
      }
    } else {
      return '__label__ = ' + getLabelId(label) + '; break;';
    }
  }

  makeFuncLineZyme('branch', function(item) {
    //print('branch: ' + dump(item));
    if (!item.ident) {
      return makeBranch(item.label);
    } else {
      var labelTrue = makeBranch(item.labelTrue);
      var labelFalse = makeBranch(item.labelFalse);
      if (labelTrue == ';' && labelFalse == ';') return ';';
      var head = 'if (' + item.ident + ') { ';
      var head2 = 'if (!(' + item.ident + ')) { ';
      var else_ = ' } else { ';
      var tail = ' }';
      if (labelTrue == ';') {
        return head2 + labelFalse + tail;
      } else if (labelFalse == ';') {
        return head + labelTrue + tail;
      } else {
        return head + labelTrue + else_ + labelFalse + tail;
      }
    }
  });
  makeFuncLineZyme('switch', function(item) {
    var ret = '';
    var first = true;
    item.switchLabels.forEach(function(switchLabel) {
      if (!first) {
        ret += 'else ';
      } else {
        first = false;
      }
      ret += 'if (' + item.ident + ' == ' + switchLabel.value + ') {\n';
      ret += '  ' + makeBranch(switchLabel.label) + '\n';
      ret += '}\n';
    });
    ret += 'else {\n';
    ret += makeBranch(item.defaultLabel) + '\n';
    ret += '}\n';
    if (item.value) {
      ret += ' ' + toNiceIdent(item.value);
    }
    return ret;
  });
  makeFuncLineZyme('return', function(item) {
    var ret = '';
    if (LABEL_DEBUG) ret += "INDENT = INDENT.substr(0, INDENT.length-2);\n";
    ret += 'return';
    if (item.value) {
      ret += ' ' + toNiceIdent(item.value);
    }
    return ret + ';';
  });
  makeFuncLineZyme('invoke', function(item) {
    // Wrapping in a function lets us easily return values if we are
    // in an assignment
    var ret = '(function() { try { return '
            + makeFunctionCall(item.ident, item.params) + '; '
            + '__THREW__ = false } catch(e) { '
            + '__THREW__ = true; '
            + '} })(); if (!__THREW__) { ' + makeBranch(item.toLabel) + ' } else { ' + makeBranch(item.unwindLabel) + ' }';
    return ret;
  });
  makeFuncLineZyme('load', function(item) {
    //print('// zz LOAD ' + dump(item) + ' :: ' + dump(item.tokens));
    var ident = toNiceIdent(item.ident);
    var impl = getVarData(item.funcData, item.ident);
    switch (impl) {
      case VAR_NATIVIZED: {
        return ident; // We have the actual value here
      }
      case VAR_EMULATED: return makeGetValue(ident);
      default: return "unknown [load] impl: " + impl;
    }
  });
  makeFuncLineZyme('alloca', function(item) {
    dprint('alloca', '// zz alloca: ' + dump(item));
    if (pointingLevels(item.allocatedType.text) == 0 && isStructType(item.allocatedType.text)) {
      // TODO: allocate on a stack, not on the heap (we currently leak all this)
      return makePointer(JSON.stringify(makeEmptyStruct(item.allocatedType.text)));
    } else {
      return makePointer('[0]');
    }
  });
  makeFuncLineZyme('mathop', function(item) { with(item) {
    dprint('mathop', 'mathop: ' + dump(item));
    switch (item.op) {
      case 'add': return ident + ' + ' + ident2;
      case 'sub': return ident + ' - ' + ident2;
      case 'sdiv': case 'udiv': return 'Math.floor(' + ident + ' / ' + ident2 + ')';
      case 'mul': return ident + ' * ' + ident2;
      case 'urem': case 'srem': return 'Math.floor(' + ident + ' % ' + ident2 + ')';
      case 'or': return ident + ' | ' + ident2;
      case 'and': return ident + ' & ' + ident2;
      case 'xor': return ident + ' ^ ' + ident2;
      case 'shl': case 'ashl': case 'lshl': return ident + ' << ' + ident2;
      case 'shr': case 'ashr': case 'lshr': return ident + ' >> ' + ident2;
      case 'fadd': return ident + ' + ' + ident2;
      case 'fsub': return ident + ' - ' + ident2;
      case 'fdiv': return ident + ' / ' + ident2;
      case 'fmul': return ident + ' * ' + ident2;
      case 'uitofp': case 'sitofp': return ident;
      case 'fptoui': case 'fptosi': return 'Math.floor(' + ident + ')';
      case 'icmp': {
        switch (variant) {
          case 'uge': case 'sge': return '0+(' + ident + ' >= ' + ident2 + ')';
          case 'ule': case 'sle': return '0+(' + ident + ' <= ' + ident2 + ')';
          case 'ugt': case 'sgt': return '0+(' + ident + ' > ' + ident2 + ')';
          case 'ult': case 'slt': return '0+(' + ident + ' < ' + ident2 + ')';
          case 'ne': case 'une': return '0+(' + ident + ' != ' + ident2 + ')';
          case 'eq': return '0+(' + ident + ' == ' + ident2 + ')';
          default: throw 'Unknown icmp variant: ' + variant
        }
      }
      case 'fcmp': {
        switch (variant) {
          case 'uge': case 'oge': return '0+(' + ident + ' >= ' + ident2 + ')';
          case 'ule': case 'ole': return '0+(' + ident + ' <= ' + ident2 + ')';
          case 'ugt': case 'ogt': return '0+(' + ident + ' > ' + ident2 + ')';
          case 'ult': case 'olt': return '0+(' + ident + ' < ' + ident2 + ')';
          case 'une': case 'one': return '0+(' + ident + ' != ' + ident2 + ')';
          case 'ueq': case 'oeq': return '0+(' + ident + ' == ' + ident2 + ')';
          default: throw 'Unknown fcmp variant: ' + variant
        }
      }
      case 'zext': case 'fpext': case 'trunc': case 'sext': case 'fptrunc': return ident;
      case 'select': return '(' + ident + ' ? ' + ident3 + ' : ' + ident4 + ')';
      case 'ptrtoint': {
        if (type.text != 'i8*') print('// XXX Warning: Risky ptrtoint operation on line ' + lineNum);
        return ident;
      }
      case 'inttoptr': {
        print('// XXX Warning: inttoptr operation on line ' + lineNum);
        return ident;
      }
      default: throw 'Unknown mathcmp op: ' + item.op
    }
  } });
/*
      return [{
        __result__: true,
        intertype: 'mathop',
        op: op,
        variant: variant,
        type: item.tokens[1].text,
        ident: item.tokens[2].text,
        value: item.tokens[4].text,
        lineNum: item.lineNum,
      }];
*/

  function getGetElementPtrIndexes(item) {
    var ident = item.ident;
    var type = item.params[0].type.text; // param 0 == type
    // struct pointer, struct*, and getting a ptr to an element in that struct. Param 1 is which struct, then we have items in that
    // struct, and possibly further substructures, all embedded
    // can also be to 'blocks': [8 x i32]*, not just structs
    type = removePointing(type);
    var indexes = [makeGetPos(ident)];
    var offset = toNiceIdent(item.params[1].ident);
    if (offset != 0) {
      indexes.push((isStructType(type) && TYPES[type].flatSize != 1 ? TYPES[type].flatSize + '*' : '') + offset);
    }
    item.params.slice(2, item.params.length).forEach(function(arg) {
      var curr = toNiceIdent(arg.ident);
      // TODO: If index is constant, optimize
      var typeData = TYPES[type];
      if (isStructType(type) && typeData.needsFlattening) {
        if (typeData.flatFactor) {
          indexes.push(curr + '*' + typeData.flatFactor);
        } else {
          indexes.push(toNiceIdent(type) + '___FLATTENER[' + curr + ']');
        }
      } else {
        if (curr != 0) {
          indexes.push(curr);
        }
      }
      type = TYPES[type] ? TYPES[type].fields[curr] : '';
    });
    return indexes.join('+');
  }

  function finalizeGetElementPtr(item) {
    //print('//zz finalize: ' + dump(item.params));
    // TODO: statically combine indexes here if consts
    return makePointer(makeGetSlab(item.ident), getGetElementPtrIndexes(item));
  }

  function finalizeBitcast(item) {
    //print('//zz finalizeBC: ' + dump(item));
    return item.ident;
  }

  makeFuncLineZyme('bitcast', function(item) {
    // XXX Don't we need to copy ptr - i.e. create new ones (at least if uses > just the next line)?
    // XXX hardcoded ptr impl - as ptrs are ints, we don't need to copy
    var ident = toNiceIdent(item.ident);
    return ident;
  });
  function makeFunctionCall(ident, params) {
    //print('// zz makeFC: ' + ident + ' : ' + dump(params));

    // Special cases
    if (ident == '_llvm_va_start') {
      if (SAFE_HEAP) {
        return 'SAFE_HEAP_STORE(' + params[0].ident + ', Pointer_make(Array.prototype.slice.call(arguments, 1).concat([0]), 0))';
      } else {
        return 'HEAP[' + params[0].ident + '] = Pointer_make(Array.prototype.slice.call(arguments, 1).concat([0]), 0)'; // XXX 1
      }
    } else if (ident == '_llvm_va_end') {
      return ';'
    }

    var params = params.map(function(param) {
      if (param.intertype === 'getelementptr') {
        return finalizeGetElementPtr(param);
      } else if (param.intertype === 'bitcast') {
        return finalizeBitcast(param);
      } else {
        return toNiceIdent(param.ident); //.value;//'??arg ' + param.intertype + '??';
      }
    });
    return ident + '(' + params.join(', ') + ')';
  }
  makeFuncLineZyme('getelementptr', function(item) { return finalizeGetElementPtr(item) });
  makeFuncLineZyme('call', function(item) {
    return makeFunctionCall(item.ident, item.params) + (item.standalone ? ';' : '');
  });

  // Optimzed intertypes

  makeFuncLineZyme('fastgetelementptrload', function(item) {
//print('// FAST ' + dump(item));
    return 'var ' + item.ident + ' = ' + makeGetValue(item.value.ident, getGetElementPtrIndexes(item.value), true) + ';';
  });
  makeFuncLineZyme('fastgetelementptrstore', function(item) {
//print('// FAST ' + dump(item));
    return makeSetValue(item.value.ident, getGetElementPtrIndexes(item.value), item.ident, true) + ';';
  });

  makeFuncLineZyme('unreachable', function(item) { return '// unreachable' });

  // Final combiner

  function finalCombiner(items) {
    var ret = items.filter(function(item) { return item.intertype == 'type' });
    ret = ret.concat(items.filter(function(item) { return item.intertype == 'globalVariable' }));
    ret.push('\n');
    ret = ret.concat(items.filter(function(item) { return item.intertype == 'functionStub' }));
    ret.push('\n');
    ret = ret.concat(items.filter(function(item) { return item.intertype == 'function' }));
    return ret.map(function(item) { return item.JS }).join('\n');
  }

  return preprocess(read('preamble.js')) + finalCombiner(substrate.solve()) + read('postamble.js');
//  return finalCombiner(substrate.solve());
}

// Main

var lines = [];
var line;
do {
  line = readline();
  if (line == null) break;
  lines.push(line);
} while(true);
var data = lines.join("\n");

//print('zz prepared')
data = intertyper(data);
//print('zz intertyped')
data = analyzer(data);
//print('zz analyzed')
data = JSify(data);
print(data);

