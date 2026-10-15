'use strict';

// Run with: node test/local-types.test.js   (plain Node, no frameworks; npm test runs it too)

const assert = require('node:assert/strict');
const Module = require('node:module');
const lib = require('../src/local-types/lib');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// "§" marks the cursor in a fixture.
function cursor(source) {
  const i = source.indexOf('§');
  assert.ok(i >= 0, 'fixture has no cursor marker');
  assert.equal(source.indexOf('§', i + 1), -1, 'fixture has two cursor markers');
  return { text: source.slice(0, i) + source.slice(i + 1), offset: i };
}

function namesAt(source, options) {
  const { text, offset } = cursor(source);
  return lib.completionCandidates(text, offset, undefined, options).map((c) => c.name).sort();
}

function contextOf(source) {
  const { text, offset } = cursor(source);
  return lib.contextAt(text, offset);
}

function typeNames(text) {
  return lib.analyze(text).types.map((t) => t.name);
}

function typeOf(text, name) {
  return lib.analyze(text).types.find((t) => t.name === name);
}

// Wraps a statement in a method of a class that declares inner types below.
function inMethod(statement) {
  return [
    'public with sharing class CheckLedgerEligibility {',
    '    public static List<Response> check(List<Request> requests) {',
    '        List<Response> out = new List<Response>();',
    `        ${statement}`,
    '        return out;',
    '    }',
    '    public class Request { public String caseNumber; }',
    '    public class Response { public Boolean eligible; public String message; }',
    '}',
    '',
  ].join('\n');
}

const ALL_THREE = ['CheckLedgerEligibility', 'Request', 'Response'];
// What survives once "R..." / "Re..." is typed: VS Code would hide the rest.
const RESP = ['Request', 'Response'];

const LEDGER = String.raw`public with sharing class CheckLedgerEligibility {
    @InvocableMethod(label='Check ledger eligibility')
    public static List<Response> check(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request req : requests) {
            Response res = new Response();
            res.eligible = req.tier == 'Gold';
            out.add(res);
        }
        Resp§
        return out;
    }

    public class Request {
        @InvocableVariable(required=true) public String caseNumber;
        @InvocableVariable public String tier;
    }

    public class Response {
        @InvocableVariable public Boolean eligible;
        @InvocableVariable public String message;
    }
}
`;

// ---------------------------------------------------------------- lib.js

test('inner classes declared below the cursor are offered', () => {
  const { text, offset } = cursor(LEDGER.replace('Resp§', '§'));
  const items = lib.completionCandidates(text, offset);
  assert.deepEqual(items.map((c) => c.name).sort(), ALL_THREE);
  assert.deepEqual(namesAt(LEDGER), RESP);
  const response = items.find((c) => c.name === 'Response');
  assert.equal(response.kind, 'class');
  assert.equal(response.detail, 'inner class of CheckLedgerEligibility');
  assert.equal(response.sortText, 'Response');
  const outer = items.find((c) => c.name === 'CheckLedgerEligibility');
  assert.equal(outer.detail, 'class in this file');
});

test('nested inner types keep the full parent path, siblings pop back', () => {
  const src = [
    'public class Outer {',
    '  public class Mid {',
    '    void m() { if (true) { Integer x = 1; } }',
    '    public class Deep { }',
    '    public interface DeepApi { }',
    '  }',
    '  public class Sibling { }',
    '}',
  ].join('\n');
  const types = lib.analyze(src).types.map((t) => [t.name, t.parent]);
  assert.deepEqual(types, [
    ['Outer', null],
    ['Mid', 'Outer'],
    ['Deep', 'Outer.Mid'],
    ['DeepApi', 'Outer.Mid'],
    ['Sibling', 'Outer'],
  ]);
  const deep = lib.analyze(src).candidates.find((c) => c.name === 'Deep');
  assert.equal(deep.detail, 'inner class of Outer.Mid');
});

test('interfaces and enums get their own kinds, enum constants are not types', () => {
  const src = [
    'public class Shapes {',
    '  public interface Drawable { void draw(); }',
    '  public enum Color { RED, GREEN, BLUE }',
    '  private enum Size { SMALL, LARGE }',
    '  public virtual class Base implements Drawable { public void draw() {} }',
    '}',
  ].join('\n');
  const byName = Object.fromEntries(lib.analyze(src).candidates.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['Base', 'Color', 'Drawable', 'Shapes', 'Size']);
  assert.equal(byName.Drawable.kind, 'interface');
  assert.equal(byName.Drawable.detail, 'inner interface of Shapes');
  assert.equal(byName.Color.kind, 'enum');
  assert.equal(byName.Color.detail, 'inner enum of Shapes');
  assert.equal(byName.Base.kind, 'class');

  const api = lib.analyze('public interface Api { void run(); }').candidates;
  assert.deepEqual(api.map((c) => [c.name, c.kind, c.detail]), [['Api', 'interface', 'interface in this file']]);
  const en = lib.analyze('public enum Tier { GOLD, SILVER }').candidates;
  assert.deepEqual(en.map((c) => [c.name, c.kind, c.detail]), [['Tier', 'enum', 'enum in this file']]);
});

test('names inside comments and string literals are ignored', () => {
  const src = String.raw`public class Real {
  // class Fake { }
  /* class Fake2 { } interface Fake3 { } */
  /**
   * enum Fake4 { A }
   */
  String a = 'class Foo { }';
  String b = 'it\'s class Foo2 { }';
  String c = '''
    class Bar { }
    interface Bar2 { }
  ''';
  String d = '\\'; public class AfterEscape { }
  String e = 'unterminated class Foo3
  public class Inner { } // class Fake5
}`;
  assert.deepEqual(typeNames(src), ['Real', 'AfterEscape', 'Inner']);
  const inner = typeOf(src, 'Inner');
  assert.equal(inner.parent, 'Real');
});

test('member access position returns nothing', () => {
  assert.deepEqual(namesAt(inMethod('out[0].§')), []);
  assert.deepEqual(namesAt(inMethod('out[0].Re§')), []);
  assert.deepEqual(namesAt(inMethod('out[0] .  Resp§')), []);
  assert.deepEqual(namesAt(inMethod('out[0]?.Resp§')), []);
  assert.deepEqual(namesAt(inMethod('CheckLedgerEligibility.Resp§')), []);
  assert.deepEqual(namesAt(inMethod('out[0]\n            .\n            Resp§')), []);
  assert.deepEqual(namesAt(inMethod('out[0]. /* x */ Resp§')), []);
  assert.equal(contextOf(inMethod('out[0].mess§')), 'member');
});

test('a comment that ends with a period is not a member access', () => {
  assert.deepEqual(namesAt(inMethod('// Build the response.\n        Resp§')), RESP);
  assert.deepEqual(namesAt(inMethod('/* done. */ Resp§')), RESP);
  assert.deepEqual(namesAt(inMethod('/* a. */\n// b.\n  Resp§')), RESP);
});

test('cursor inside a comment returns nothing', () => {
  assert.deepEqual(namesAt(inMethod('// Resp§')), []);
  assert.deepEqual(namesAt(inMethod('// note Resp§\n        Integer x = 1;')), []);
  assert.deepEqual(namesAt(inMethod('/* Resp§ */')), []);
  assert.deepEqual(namesAt(inMethod('/**\n         * Resp§\n         */')), []);
  assert.deepEqual(namesAt('public class A { public class B {} /* unterminated Resp§'), []);
  assert.equal(contextOf(inMethod('// Resp§')), 'comment');
  // Right before the comment and right after a closed one is code again.
  assert.deepEqual(namesAt(inMethod('Resp§// trailing')), RESP);
  assert.deepEqual(namesAt(inMethod('/* x */§')), ALL_THREE);
});

test('cursor inside a string literal returns nothing', () => {
  assert.deepEqual(namesAt(inMethod("String s = 'Resp§';")), []);
  assert.deepEqual(namesAt(inMethod(String.raw`String s = 'it\'s Resp§';`)), []);
  assert.deepEqual(namesAt(inMethod("String s = 'Resp§\n        Integer x = 1;")), []);
  assert.deepEqual(namesAt(inMethod("String s = '''\n          Resp§\n        ''';")), []);
  assert.deepEqual(namesAt(inMethod("String s = '''Resp§")), []);
  assert.equal(contextOf(inMethod("String s = 'Resp§';")), 'string');
  // After a closed string it is code again.
  assert.deepEqual(namesAt(inMethod("Object o = 'abc' + Resp§")), RESP);
  assert.deepEqual(namesAt(inMethod("String s = '';§")), ALL_THREE);
});

test('generic, constructor, cast and extends positions return items', () => {
  assert.deepEqual(namesAt(inMethod('List<Resp§')), RESP);
  assert.deepEqual(namesAt(inMethod('Map<String, Resp§')), RESP);
  assert.deepEqual(namesAt(inMethod('new Resp§')), RESP);
  assert.deepEqual(namesAt(inMethod('new List<Resp§')), RESP);
  assert.deepEqual(namesAt(inMethod('Object o = (Resp§')), RESP);
  assert.deepEqual(namesAt(inMethod('Resp§')), RESP);
  assert.deepEqual(namesAt(inMethod('§')), ALL_THREE);
  assert.deepEqual(namesAt(inMethod('List<§')), ALL_THREE);
  assert.deepEqual(namesAt(inMethod('new §')), ALL_THREE);
  assert.deepEqual(namesAt('public class A { public class B extends Resp§ {} public class Response {} }'), ['Response']);
  assert.deepEqual(namesAt('public class A { public class B extends § {} public class Response {} }'), ['A', 'B', 'Response']);
});

test('annotation and type-name positions return nothing', () => {
  assert.deepEqual(namesAt(inMethod('@Invo§')), []);
  assert.equal(contextOf(inMethod('@Invo§')), 'annotation');
  assert.deepEqual(namesAt('public class A { public class Resp§ }'), []);
  assert.deepEqual(namesAt('public class A { enum Col§ }'), []);
  assert.deepEqual(namesAt('public class A { public interface §'), []);
  assert.equal(contextOf('public class A { public class Resp§ }'), 'declaration');
});

test('"class" inside a longer identifier or after a dot is not a keyword', () => {
  const src = [
    'public class Holder {',
    '  Integer subclass = 1;',
    '  subclass Fake1;',
    '  myclass Fake2;',
    '  classic Fake3;',
    '  Boolean class_flag = true;',
    '  Type t = Holder.class;',
    '  String n = Holder.class.getName();',
    '  Type u = Holder . class ;',
    '  myenum Fake4; superinterface Fake5;',
    '  PUBLIC CLASS Shouty { }',
    '  public Enum Mixed { A }',
    '}',
  ].join('\n');
  assert.deepEqual(typeNames(src), ['Holder', 'Shouty', 'Mixed']);
  assert.equal(typeOf(src, 'Mixed').kind, 'enum');
  assert.equal(typeOf(src, 'Shouty').parent, 'Holder');
  // Missing semicolon while typing: "Foo.class" followed by the next line's type.
  assert.deepEqual(typeNames('public class H { Type t = H.class\n  String s; }'), ['H']);
});

test('extends / implements lists do not create types', () => {
  const src = [
    'public class Child extends Base implements Foo, Bar, Database.Batchable<SObject> {',
    '  public class Leaf extends Child implements Comparable, Schedulable {',
    '    public Integer compareTo(Object other) { return 0; }',
    '  }',
    '  public interface Api extends Foo, Bar { }',
    '}',
  ].join('\n');
  assert.deepEqual(typeNames(src), ['Child', 'Leaf', 'Api']);
  assert.equal(typeOf(src, 'Leaf').parent, 'Child');
  assert.equal(typeOf(src, 'Api').parent, 'Child');
});

test('generic uses like List<Response> are not declarations', () => {
  const src = 'public class A { List<Response> a; Map<Id, List<Request>> b; Set<Other> c; }';
  assert.deepEqual(typeNames(src), ['A']);
});

test('a type header without a body does not swallow the next method body', () => {
  const src = [
    'public class A {',
    '  public class B',
    '  public void run() { if (x) { } }',
    '  public class C { }',
    '}',
  ].join('\n');
  const types = lib.analyze(src).types.map((t) => [t.name, t.parent]);
  // "B" is not followed by "{", extends or implements, so it declares nothing (yet).
  assert.deepEqual(types, [['A', null], ['C', 'A']]);
  // A header still being typed at the very end of the text does count.
  assert.deepEqual(typeNames('public class A { }\npublic class Draft'), ['A', 'Draft']);
  assert.deepEqual(typeNames('public class A extends Base'), ['A']);
  assert.deepEqual(typeNames('public class A /* body next */ {'), ['A']);
});

test('CRLF and LF give the same declarations and contexts', () => {
  const lf = LEDGER.replace('§', '');
  const crlf = lf.replace(/\n/g, '\r\n');
  const strip = (text) => lib.analyze(text).types.map((t) => [t.name, t.kind, t.parent]);
  assert.deepEqual(strip(crlf), strip(lf));
  assert.deepEqual(namesAt(LEDGER.replace(/\n/g, '\r\n')), RESP);
  assert.deepEqual(namesAt(LEDGER.replace('Resp§', '§').replace(/\n/g, '\r\n')), ALL_THREE);

  const comment = inMethod('// note Resp§\n        Integer x = 1;');
  assert.deepEqual(namesAt(comment), []);
  assert.deepEqual(namesAt(comment.replace(/\n/g, '\r\n')), []);
  const nextLine = inMethod('// Build the response.\n        Resp§');
  assert.deepEqual(namesAt(nextLine.replace(/\n/g, '\r\n')), RESP);
  const str = inMethod("String s = 'Resp§\n        Integer x = 1;");
  assert.deepEqual(namesAt(str.replace(/\n/g, '\r\n')), []);
  const member = inMethod('out[0]\n            .\n            Resp§');
  assert.deepEqual(namesAt(member.replace(/\n/g, '\r\n')), []);
  // A line comment in CRLF ends at "\r", the next line is code.
  const a = lib.analyze('// x\r\npublic class A { }');
  assert.equal(a.regions[0].end, 4);
  assert.deepEqual(a.types.map((t) => t.name), ['A']);
});

test('duplicate names are offered once (Apex names are case-insensitive)', () => {
  const src = [
    'public class Top {',
    '  public class A { public class Item { } }',
    '  public class B { public class Item { } }',
    '  public class ITEM2 { } public class item2 { }',
    '}',
  ].join('\n');
  const items = lib.analyze(src).candidates;
  assert.deepEqual(items.map((c) => c.name), ['Top', 'A', 'Item', 'B', 'ITEM2']);
  assert.equal(items.find((c) => c.name === 'Item').detail, 'inner class of Top.A');
});

test('odd input does not throw', () => {
  for (const text of ['', ' ', '}', '}}}{', "'", "'''", '/*', '//', '\\', 'class', 'class ', '﻿public class Bom {}']) {
    lib.analyze(text);
    for (let o = -1; o <= text.length + 1; o++) lib.completionCandidates(text, o);
  }
  assert.deepEqual(lib.completionCandidates(null, 0), []);
  assert.deepEqual(lib.completionCandidates(undefined, NaN), []);
  assert.deepEqual(typeNames('﻿public class Bom {}'), ['Bom']);
  assert.deepEqual(typeNames('public class __proto__ { } class constructor { }'), ['__proto__', 'constructor']);
});

// ------------------------------------------------ review regressions (lib.js)

test('a keyword after a nameless class / enum / interface header is not a type', () => {
  // A new inner type typed above existing code, its name not typed yet.
  const a = 'public class Outer {\n  public class \n  public void m() { p§ }\n  public class Response {}\n}\n';
  assert.deepEqual(namesAt(a), []);
  assert.deepEqual(typeNames(cursor(a).text), ['Outer', 'Response']);
  const b = 'public class Outer {\n  enum\n  void m() { v§ }\n}\n';
  assert.deepEqual(namesAt(b), []);
  assert.deepEqual(typeNames(cursor(b).text), ['Outer']);
  const c = 'public class Outer {\n  private class\n  static Integer x;\n  void m() { s§ }\n}';
  assert.deepEqual(namesAt(c), []);
  assert.deepEqual(typeNames(cursor(c).text), ['Outer']);
  // A static initializer right after the nameless header: "static {".
  const d = 'public class Outer {\n  public class\n  static { Integer y = 1; }\n  void m() { s§ }\n}';
  assert.deepEqual(namesAt(d), []);
  assert.deepEqual(typeNames(cursor(d).text), ['Outer']);
  // A type name used by the next member is not declared either.
  const e = 'public class Outer {\n  private class\n  Account acc;\n  void m() { A§ }\n}';
  assert.deepEqual(namesAt(e), []);
  assert.deepEqual(typeNames(cursor(e).text), ['Outer']);
  assert.deepEqual(typeNames('public class Outer {\n  public interface\n  PUBLIC VOID run() { }\n}'), ['Outer']);
  assert.deepEqual(typeNames('public class Outer { } class\n  public'), ['Outer']);
  assert.deepEqual(typeNames('public class Outer {\n  public class\n  public class Inner { }\n}'), ['Outer', 'Inner']);
  // Names that are only "reserved for future use" in Apex still work as names.
  assert.deepEqual(typeNames('public class Outer { public class Inner { } public enum Number { ONE } }'), ['Outer', 'Inner', 'Number']);
});

test('no local type names inside inline SOQL / SOSL, except in bind expressions', () => {
  assert.deepEqual(namesAt(inMethod('List<Account> a = [SELECT Id, Re§ FROM Account];')), []);
  assert.deepEqual(namesAt(inMethod('List<Account> b = [SELECT Id FROM Re§];')), []);
  assert.deepEqual(namesAt(inMethod("List<List<SObject>> d = [FIND 'x' IN ALL FIELDS RETURNING Re§];")), []);
  assert.deepEqual(namesAt(inMethod('List<Account> e = [select id from Re§];')), []);
  assert.deepEqual(namesAt(inMethod('List<Account> f = [SELECT Id FROM Account WHERE §];')), []);
  assert.deepEqual(namesAt(inMethod("List<Account> g = [ /* q */ SELECT Id FROM Account WHERE Name = 'x' AND Re§];")), []);
  assert.deepEqual(namesAt(inMethod('Integer n = [SELECT COUNT() FROM Account WHERE Id IN (SELECT AccountId FROM Contact WHERE Re§)];')), []);
  assert.deepEqual(namesAt(inMethod('List<Account> h = [SELECT Id FROM Account WHERE Id = :ids[0] AND Re§];')), []);
  assert.deepEqual(namesAt(inMethod("List<Account> k = [SELECT Id FROM Account WHERE Name IN :new Set<String>{'a'} AND Re§];")), []);
  assert.equal(contextOf(inMethod('List<Account> b = [SELECT Id FROM Re§];')), 'soql');
  assert.equal(contextOf(inMethod("List<Account> s = [SELECT Id FROM Account WHERE Name = 'Re§'];")), 'string');
  assert.equal(contextOf(inMethod('List<Account> m = [SELECT Id FROM Account WHERE Owner.Na§];')), 'member');
  // Bind expressions are Apex: local type names are valid there.
  assert.deepEqual(namesAt(inMethod('List<Account> c = [SELECT Id FROM Account WHERE Name = :Re§];')), RESP);
  assert.deepEqual(namesAt(inMethod('List<Account> c = [SELECT Id FROM Account WHERE Name = : Re§];')), RESP);
  assert.deepEqual(namesAt(inMethod('List<Account> c = [SELECT Id FROM Account WHERE Name = :§];')), ALL_THREE);
  assert.deepEqual(namesAt(inMethod('List<Account> c = [SELECT Id FROM Account WHERE Name = :Response.Re§];')), []);
  // Outside the brackets it is code again.
  assert.deepEqual(namesAt(inMethod('List<Account> a = [SELECT Id FROM Account]; Re§')), RESP);
  assert.deepEqual(namesAt(inMethod('for (Account a : [SELECT Id FROM Account]) { Re§ }')), RESP);
  assert.deepEqual(namesAt(inMethod('Re§ x = [SELECT Id FROM Account];')), RESP);
  // Array indexes and array literals are not queries.
  assert.deepEqual(namesAt(inMethod('Object o = out[Re§];')), RESP);
  assert.deepEqual(namesAt(inMethod('Object o = new Response[]{}; Re§')), RESP);
  // An unterminated query (still being typed) ends at ";" or an unbalanced "}".
  assert.deepEqual(namesAt(inMethod('List<Account> u = [SELECT Id FROM Re§')), []);
  assert.deepEqual(namesAt(inMethod('List<Account> u = [SELECT Id FROM Acc;\n        Re§')), RESP);
  assert.deepEqual(namesAt('public class A { void m() { List<Account> u = [SELECT Id FROM Acc\n } public class Response { } void n() { Re§ } }'), ['Response']);
  // Words inside a query never declare types.
  assert.deepEqual(typeNames('public class A { void m() { List<X__c> l = [SELECT Id, Class, Enum FROM X__c]; } }'), ['A']);
  // CRLF behaves the same.
  assert.deepEqual(namesAt(inMethod('List<Account> b = [SELECT Id\n            FROM Re§];').replace(/\n/g, '\r\n')), []);
});

test("the file's own top-level type can be left out (the language server offers it)", () => {
  const src = inMethod('§');
  assert.deepEqual(namesAt(src, { ownTypeName: 'CheckLedgerEligibility' }), RESP);
  assert.deepEqual(namesAt(src, { ownTypeName: 'checkledgereligibility' }), RESP);
  assert.deepEqual(namesAt(src, { ownTypeName: 'Other' }), ALL_THREE);
  assert.deepEqual(namesAt(src, {}), ALL_THREE);
  assert.deepEqual(namesAt(inMethod('Che§'), { ownTypeName: 'CheckLedgerEligibility' }), []);
  // Only a top-level type is dropped, never an inner one with that name.
  assert.deepEqual(namesAt('public class Foo { public class Response { } void m() { § } }', { ownTypeName: 'Response' }), ['Foo', 'Response']);
  const byName = Object.fromEntries(lib.analyze(src).candidates.map((c) => [c.name, c.topLevel]));
  assert.deepEqual(byName, { CheckLedgerEligibility: true, Request: false, Response: false });
  assert.equal(lib.typeNameFromPath('/c:/force-app/main/default/classes/CheckLedgerEligibility.cls'), 'CheckLedgerEligibility');
  assert.equal(lib.typeNameFromPath('C:\\proj\\classes\\Foo.cls'), 'Foo');
  assert.equal(lib.typeNameFromPath('Untitled-1'), 'Untitled-1');
  assert.equal(lib.typeNameFromPath(''), null);
  assert.equal(lib.typeNameFromPath(undefined), null);
});

test('only names the editor can match against the typed word are returned', () => {
  // Nothing declared can match "acc": return nothing, so VS Code still falls
  // back to its word-based suggestions (accountCount).
  const untitled = 'public class Foo {\n    void m() {\n        Integer accountCount = 1;\n        acc§\n    }\n}\n';
  assert.deepEqual(namesAt(untitled), []);
  assert.deepEqual(namesAt(untitled.replace('acc§', 'F§')), ['Foo']);
  assert.deepEqual(namesAt(untitled.replace('acc§', 'fo§')), ['Foo']);
  assert.deepEqual(namesAt(untitled.replace('acc§', '§')), ['Foo']);
  // Case-insensitive; camelCase humps and "_" boundaries count as word starts.
  const src = 'public class CheckLedgerEligibility { class Order_item { } class HTTPWrapper { } void m() { § } }';
  const at = (word, options) => namesAt(src.replace('§', `${word}§`), options);
  assert.deepEqual(at(''), ['CheckLedgerEligibility', 'HTTPWrapper', 'Order_item']);
  assert.deepEqual(at('ch'), ['CheckLedgerEligibility']);
  assert.deepEqual(at('Elig'), ['CheckLedgerEligibility']);
  assert.deepEqual(at('ledger'), ['CheckLedgerEligibility']);
  assert.deepEqual(at('it'), ['Order_item']);
  assert.deepEqual(at('_i'), ['Order_item']);
  assert.deepEqual(at('h'), ['HTTPWrapper']);
  assert.deepEqual(at('w'), []); // "W" right after "P" is not a hump for VS Code
  assert.deepEqual(at('x'), []);
  // editor.suggest.matchOnWordStartOnly = false: any position may match.
  assert.deepEqual(at('w', { wordStartOnly: false }), ['HTTPWrapper']);
  assert.deepEqual(at('h', { wordStartOnly: false }), ['CheckLedgerEligibility', 'HTTPWrapper']);
  assert.deepEqual(at('x', { wordStartOnly: false }), []);
});

function syntheticApex(lineCount) {
  const out = ['public with sharing class BigService {'];
  let k = 0;
  while (out.length < lineCount - 1) {
    out.push(`    // Section ${k}: class Fake${k} lives only in this comment.`);
    out.push(`    public class Dto${k} extends BaseDto implements Comparable {`);
    out.push(`        public String label = 'class NotAType${k} { }';`);
    out.push(`        public List<Dto${k}> children = new List<Dto${k}>();`);
    out.push(`        /* interface Hidden${k} { } */`);
    out.push('        public Integer compareTo(Object other) {');
    out.push('            if (other == null || label.isEmpty()) { return 0; }');
    out.push(`            return children.size() * ${k} + label.length();`);
    out.push('        }');
    out.push('    }');
    out.push(`    public enum State${k} { OPEN, CLOSED }`);
    k++;
  }
  out.push('    public void run() {');
  out.push('        List<Dto');
  out.push('    }');
  out.push('}');
  return { text: out.join('\n'), blocks: k, lines: out.length };
}

test('5000-line file: analysis and completion take under 50 ms', () => {
  const { text, blocks, lines } = syntheticApex(5000);
  assert.ok(lines >= 5000, `only ${lines} lines`);
  const offset = text.indexOf('List<Dto\n') + 'List<Dto'.length;

  const t0 = process.hrtime.bigint();
  const analysis = lib.analyze(text);
  const items = lib.completionCandidates(text, offset, analysis);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.equal(analysis.types.length, 1 + blocks * 2);
  // "Dto" is typed: only the Dto classes can match, not State* or BigService.
  assert.equal(items.length, blocks);
  assert.ok(items.every((c) => /^Dto\d+$/.test(c.name)));
  assert.equal(analysis.candidates.length, 1 + blocks * 2);
  assert.ok(!analysis.candidates.some((c) => /^(Fake|NotAType|Hidden|BaseDto|Comparable)/.test(c.name)));
  assert.ok(ms < 50, `took ${ms.toFixed(2)} ms`);
  return `${lines} lines, ${(text.length / 1024).toFixed(0)} KB, ${analysis.types.length} types, ${ms.toFixed(2)} ms cold`;
});

// ------------------------------------- lib.js: shapes that crash the language server

// The class jorje was compiling when it crashed (Apex Language Server log,
// 2026-10-14 12:43:59).
const LOGGED = [
  'public with sharing class LedgerEligibility {',
  '    @InvocableMethod',
  '    public static void checkLedgerEligibility(List) {',
  '    }',
  '    public class Request {',
  '        @InvocableVariable',
  '        public String caseNumber;',
  '    }',
  '    public class Response {',
  '    }',
  '}',
  '',
].join('\n');

const CONSEQUENCE = "The Apex language server crashes on it and stops suggesting members after '.' in this file.";
const RETURN_CONSEQUENCE = "The Apex language server cannot parse this method and suggests no members after '.' inside it.";

// A class shaped like LOGGED with "header" (annotation + signature + "{") as
// its only method.
function classWith(header, top = 'public with sharing class Shape {') {
  return [
    top,
    `    ${header}`,
    '    }',
    '    public class Request {',
    '        @InvocableVariable',
    '        public String caseNumber;',
    '    }',
    '    public class Response {',
    '    }',
    '}',
    '',
  ].join('\n');
}

function breakers(text) {
  return lib.findCompletionBreakers(text);
}

function applyFix(text, fix) {
  return text.slice(0, fix.edit.start) + fix.edit.newText + text.slice(fix.edit.end);
}

function flaggedText(text) {
  return breakers(text).map((b) => text.slice(b.start, b.end));
}

test('the logged raw List in an @InvocableMethod is flagged and the quick fix types it', () => {
  const found = breakers(LOGGED);
  assert.equal(found.length, 1);
  const [b] = found;
  assert.equal(b.start, LOGGED.indexOf('(List)') + 1);
  assert.equal(LOGGED.slice(b.start, b.end), 'List');
  assert.equal(b.code, 'jorje-crash');
  assert.equal(b.message, `Raw List in an @InvocableMethod parameter. ${CONSEQUENCE} Use List<Type>.`);
  assert.deepEqual(b.fixes.map((f) => [f.title, f.preferred]), [['Change to List<Request> requests', true]]);
  const fixed = applyFix(LOGGED, b.fixes[0]);
  assert.ok(fixed.includes('    public static void checkLedgerEligibility(List<Request> requests) {\n'), fixed);
  assert.deepEqual(breakers(fixed), []);
});

test('every parameter shape measured to crash the language server is flagged', () => {
  const GLOBAL = 'global with sharing class Shape {';
  const REST = "@RestResource(urlMapping='/shape/*')\nglobal with sharing class Shape {";
  // [method header, class header or undefined, flagged text, message start]
  const cases = [
    ['@InvocableMethod public static void check(List requests) {', undefined, 'List', 'Raw List in an @InvocableMethod parameter'],
    ['@InvocableMethod public static void check(List) {', undefined, 'List', 'Raw List in an @InvocableMethod'],
    ['@invocablemethod public static void check(list requests) {', undefined, 'list', 'Raw list in an @InvocableMethod'],
    ["@InvocableMethod(label='Check' description='d') public static void check(List requests) {", undefined, 'List', 'Raw List'],
    ['@TestVisible @InvocableMethod public static void check(List requests) {', undefined, 'List', 'Raw List'],
    ['@InvocableMethod public void check(List requests) {', undefined, 'List', 'Raw List'], // not static: still checked
    ['@InvocableMethod public static void check(final List requests) {', undefined, 'List', 'Raw List'],
    ['@InvocableMethod public static void check(List<List> requests) {', undefined, 'List', 'Raw List'],
    ['@InvocableMethod public static void check(List<> requests) {', undefined, 'List<>', 'List<> without a type argument in an @InvocableMethod'],
    ['@InvocableMethod public static void check(List <  > requests) {', undefined, 'List <  >', 'List < > without a type argument'],
    ['@InvocableMethod public static void check(List<) {', undefined, 'List<', 'Unclosed List< in an @InvocableMethod'],
    ['@InvocableMethod public static void check(List< ) {', undefined, 'List<', 'Unclosed List<'],
    ['@InvocableMethod public static void check(List<R) {', undefined, 'List<R', 'Unclosed List<R'],
    ['@InvocableMethod public static void check(List<Request) {', undefined, 'List<Request', 'Unclosed List<Request'],
    ['@InvocableMethod public static void check(List<List<Req) {', undefined, 'List<List<Req', 'Unclosed List<List<Req'],
    ['@InvocableMethod public static void check(List {', undefined, 'List', 'Raw List'],
    ['@InvocableMethod public static void check(List<String, String> requests) {', undefined, 'List<String, String>', 'List with 2 type arguments (List takes 1) in an @InvocableMethod'],
    ['@InvocableMethod public static void check(List<Req, String b) {', undefined, 'List<Req, String', 'List with 2 type arguments'],
    ['@InvocableMethod public static void check(List<List<String, String>> requests) {', undefined, 'List<String, String>', 'List with 2 type arguments'],
    ['@InvocableMethod global static void check(List requests) {', GLOBAL, 'List', 'Raw List in an @InvocableMethod'],
    ['@AuraEnabled public static void check(List requests) {', undefined, 'List', 'Raw List in an @AuraEnabled parameter'],
    ['@AuraEnabled(cacheable=true) public static void check(String a, List b) {', undefined, 'List', 'Raw List in an @AuraEnabled'],
    ['@AuraEnabled private static void check(List requests) {', undefined, 'List', 'Raw List'],
    ['@AuraEnabled static void check(List requests) {', undefined, 'List', 'Raw List'],
    ['@AuraEnabled public static void check(Map requests) {', undefined, 'Map', 'Raw Map in an @AuraEnabled parameter. ' + CONSEQUENCE + ' Use Map<Key, Value>.'],
    ['@AuraEnabled public static void check(Map<String> requests) {', undefined, 'Map<String>', 'Map with 1 type argument (Map takes 2)'],
    ['@AuraEnabled public static void check(Map<String) {', undefined, 'Map<String', 'Unclosed Map<String'],
    ['@AuraEnabled public static void check(Map<String, List> requests) {', undefined, 'List', 'Raw List'],
    ['@AuraEnabled public static void check(Map<List, String> requests) {', undefined, 'List', 'Raw List'],
    ['@AuraEnabled public static void check(List<Map> requests) {', undefined, 'Map', 'Raw Map'],
    ['@AuraEnabled public static void check(List<List<List>> requests) {', undefined, 'List', 'Raw List'],
    ['@AuraEnabled public static void check(Set<String> a, Map b) {', undefined, 'Map', 'Raw Map'],
    ['@AuraEnabled public static void check(Map<String, List<>> requests) {', undefined, 'List<>', 'List<> without a type argument'],
    ['@HttpPost global static void check(List requests) {', REST, 'List', 'Raw List in an @HttpPost parameter'],
    ['@HttpGet global static void check(List requests) {', REST, 'List', 'Raw List in an @HttpGet parameter'],
    ['@HttpPost public static void check(Map requests) {', undefined, 'Map', 'Raw Map in an @HttpPost'],
    ['@HttpPost public static void check(List<Map> requests) {', undefined, 'Map', 'Raw Map in an @HttpPost'],
    ['webservice static void check(List requests) {', GLOBAL, 'List', 'Raw List in a webservice method parameter'],
    ['webservice static void check(List<List> requests) {', GLOBAL, 'List', 'Raw List in a webservice'],
    ['webservice static void check(List<String, String> requests) {', GLOBAL, 'List<String, String>', 'List with 2 type arguments'],
    ['global static void check(List requests) {', GLOBAL, 'List', 'Raw List in a global method parameter'],
    ['global static void check(List requests) {', undefined, 'List', 'Raw List in a global method'],
    ['global static void check(Set requests) {', GLOBAL, 'Set', 'Raw Set in a global method parameter. ' + CONSEQUENCE + ' Use Set<Type>.'],
    ['global static void check(Map requests) {', GLOBAL, 'Map', 'Raw Map in a global'],
    ['global static void check(Set<List> requests) {', GLOBAL, 'List', 'Raw List'],
    ['global static void check(Set<String, String> requests) {', GLOBAL, 'Set<String, String>', 'Set with 2 type arguments (Set takes 1)'],
    ['global static void check(List<Req) {', GLOBAL, 'List<Req', 'Unclosed List<Req in a global method'],
    // An empty argument slot crashes type resolution in any method.
    ['public static void check(List< > requests) {', undefined, 'List< >', 'List< > without a type argument in a method parameter'],
    ['public static void check(List < >) {', undefined, 'List < >', 'List < > without a type argument'],
    ['public static void check(String a, Map< > b) {', undefined, 'Map< >', 'Map< > without a type argument'],
    ['public static void check(List<List< >> requests) {', undefined, 'List< >', 'List< > without'],
    ['public static void check(List<String, > requests) {', undefined, 'List<String, >', 'Empty type argument in List<String, > in a method parameter'],
    ['public static void check(List<,String> requests) {', undefined, 'List<,String>', 'Empty type argument'],
    ['public static void check(Map<String,> requests) {', undefined, 'Map<String,>', 'Empty type argument'],
    ['public Shape(List< > items) {', undefined, 'List< >', 'List< > without a type argument in a constructor parameter'],
  ];
  for (const [header, top, flagged, message] of cases) {
    const text = classWith(header, top);
    const found = breakers(text);
    assert.equal(found.length, 1, header);
    assert.equal(text.slice(found[0].start, found[0].end), flagged, header);
    assert.ok(found[0].message.startsWith(message), `${header}\n  ${found[0].message}`);
    // The remedy names the collection that was flagged.
    const kind = /^(?:raw |unclosed |empty type argument in )?(list|set|map)/i.exec(flagged.trim())[1].toLowerCase();
    const use = { list: 'List<Type>', set: 'Set<Type>', map: 'Map<Key, Value>' }[kind];
    assert.ok(found[0].message.endsWith(` ${CONSEQUENCE} Use ${use}.`), `${header}\n  ${found[0].message}`);
  }
  return `${cases.length} shapes`;
});

test('shapes that measured clean stay quiet', () => {
  const GLOBAL = 'global with sharing class Shape {';
  const clean = [
    // @InvocableMethod: only List and List<List> are unwrapped, one parameter only.
    '@InvocableMethod public static List<Response> check(List<Request> requests) {',
    '@InvocableMethod public static void check(List<List<Request>> requests) {',
    '@InvocableMethod public static void check(List<List<List>> requests) {',
    '@InvocableMethod public static void check(Set requests) {',
    '@InvocableMethod public static void check(Map requests) {',
    '@InvocableMethod public static void check(Iterable requests) {',
    '@InvocableMethod public static void check(System.List requests) {',
    '@InvocableMethod public static void check(List<Set> requests) {',
    '@InvocableMethod public static void check(List<Object> requests) {',
    '@InvocableMethod public static void check(List<Request> a, List b) {',
    '@InvocableMethod public static void check(List<Request requests) {', // jorje inserts the ">"
    '@InvocableMethod public static void check(List<List<Request> requests) {',
    '@InvocableMethod public static void check(List<Request>) {',
    '@InvocableMethod public static void check(List < Request > requests) {',
    '@InvocableMethod public static void check(List<Request>[] requests) {',
    '@InvocableMethod public static void check(L) {',
    '@InvocableMethod public static void check(Lis) {',
    // Return types jorje recovers from or accepts.
    '@InvocableMethod public static List<Res check(List<Request> requests) {',
    '@InvocableMethod public static List<String, String> check(List<Request> requests) {',
    '@AuraEnabled public static Map<String> check(String a) {',
    'public static List<String, String> check(String a) {',
    // No annotation, no global / webservice: raw collections are just syntax errors.
    'public static void check(List requests) {',
    'public static void check(List) {',
    'public static void check(List<Req) {',
    'public static void check(List<Request> requests {', // ")" missing, body kept
    'public static void check(String a {',
    'public static void check(List<> requests) {', // "<>" is one token: no empty slot
    'public static void check(List<String, String> requests) {',
    'public static void check(Iterable< > requests) {',
    // @AuraEnabled: instance methods are rejected first, Set is never unwrapped.
    '@AuraEnabled public void check(List requests) {',
    '@AuraEnabled public static void check(Set requests) {',
    '@AuraEnabled public static void check(List<Set> requests) {',
    '@AuraEnabled public static void check(Set<List> requests) {',
    '@AuraEnabled(cacheable=true) public static List<Account> check(List<Account> accounts) {',
    '@RemoteAction public static void check(List requests) {',
    '@future public static void check(List requests) {',
    '@HttpPost public static void check(Set requests) {',
    '@HttpPost public static void check(Set<List> requests) {',
  ];
  for (const header of clean) assert.deepEqual(flaggedText(classWith(header)), [], header);
  const cleanGlobal = [
    'webservice static void check(Set requests) {',
    'webservice static void check(Map requests) {',
    'webservice static void check(Map<String, List> requests) {',
    'webservice static void check(List<Set> requests) {',
    'public static void check(List requests) {',
    'global static void check(List<Request> requests) {',
  ];
  for (const header of cleanGlobal) assert.deepEqual(flaggedText(classWith(header, GLOBAL)), [], header);
  // Fields, properties and locals never crash it (they fail to parse instead).
  const members = [
    'public class Shape {',
    '    @InvocableVariable public List values;',
    '    @InvocableVariable public List<List> nested;',
    '    @AuraEnabled public List<List> items { get; set; }',
    '    global List<List> more;',
    '    public List< > holes;',
    '    public void run() { List items; List< > more; Map<String, > m; }',
    '}',
  ].join('\n');
  assert.deepEqual(flaggedText(members), []);
  return `${clean.length + cleanGlobal.length} signatures`;
});

test('analyze() records member-level blocks (bodies the crash check skips)', () => {
  const src = [
    'public class A {',
    '    void m() { if (x) { y(); } }',
    "    static { String s = '}'; /* { */ }",
    '    String name { get; set; }',
    "    Map<String, Integer> codes = new Map<String, Integer>{ 'a' => 1 };",
    '    public class B { void n() { } }',
    '    public enum E { ONE }',
    '    void open() {',
  ].join('\n');
  const blocks = lib.analyze(src).blocks.map((b) => [src.slice(b.start, b.end).replace(/\s+/g, ' '), b.closed]);
  assert.deepEqual(blocks, [
    ['{ if (x) { y(); } }', true],
    ["{ String s = '}'; /* { */ }", true],
    ['{ get; set; }', true],
    ["{ 'a' => 1 }", true],
    ['{ }', true],
    ['{', false], // still being typed: runs to the end of the text
  ]);
  // A crash shape inside a body (a local, not a parameter) is never looked at.
  assert.deepEqual(flaggedText(classWith('@InvocableMethod public static void check(List<Request> requests) { List< > x; global(List y);')), []);
});

test('return types the parser cannot read are flagged; the parameter checks do not run there', () => {
  const cases = [
    // [method header, flagged text, message start]
    ['@InvocableMethod public static List check(List<Request> requests) {', 'List', 'Raw List in the return type'],
    ['public static List check(String a) {', 'List', 'Raw List in the return type'],
    ['public List check() {', 'List', 'Raw List'],
    ['public static Set check(String a) {', 'Set', 'Raw Set in the return type'],
    ['public static Map check(String a) {', 'Map', 'Raw Map in the return type'],
    ['public static List<List> check(String a) {', 'List', 'Raw List in the return type'],
    ['public static Map<String, List> check(String a) {', 'List', 'Raw List'],
    ['@InvocableMethod public static List<> check(List<Request> requests) {', 'List<>', 'List<> without a type argument in the return type'],
    ['public static List< > check(String a) {', 'List< >', 'List< > without a type argument in the return type'],
    ['@AuraEnabled public static List check(String a) {', 'List', 'Raw List'],
    ['global static List<List> check(String a) {', 'List', 'Raw List'],
  ];
  for (const [header, flagged, message] of cases) {
    const text = classWith(header);
    const found = breakers(text);
    assert.equal(found.length, 1, header);
    assert.equal(found[0].code, 'jorje-parse', header);
    assert.equal(text.slice(found[0].start, found[0].end), flagged, header);
    assert.ok(found[0].message.startsWith(message), `${header}\n  ${found[0].message}`);
    assert.ok(found[0].message.includes(` ${RETURN_CONSEQUENCE} Use `), found[0].message);
  }
  // The parameter checks need a parsed method: a raw List parameter behind a
  // raw List return type is reported once the return type is fixed (as measured).
  const both = classWith('@InvocableMethod public static List check(List requests) {');
  const [r] = breakers(both);
  assert.deepEqual(breakers(both).map((b) => b.code), ['jorje-parse']);
  assert.equal(r.fixes[0].title, 'Change the return type to List<Response>');
  const step = applyFix(both, r.fixes[0]);
  assert.deepEqual(breakers(step).map((b) => [b.code, step.slice(b.start, b.end)]), [['jorje-crash', 'List']]);
  // An empty argument slot crashes even there: both are reported.
  const hole = classWith('public static List check(List< > items) {');
  assert.deepEqual(breakers(hole).map((b) => [b.code, hole.slice(b.start, b.end)]), [['jorje-parse', 'List'], ['jorje-crash', 'List< >']]);
});

test('parameter lists that swallow the method body are flagged in any method', () => {
  const cases = [
    // [method header, flagged text, message start, fixed header]
    ['public static void check(List<) {', 'List<', 'Unclosed List< in a method parameter', 'public static void check(List<String> strings) {'],
    ['public static void check(List< ) {', 'List<', 'Unclosed List<', 'public static void check(List<String> strings) {'],
    ['public static void check(Set<) {', 'Set<', 'Unclosed Set<', 'public static void check(Set<String> strings) {'],
    ['public static void check(Map<) {', 'Map<', 'Unclosed Map<', 'public static void check(Map<String, Object> values) {'],
    ['public static void check(Map<String,) {', 'Map<String,', 'Unclosed Map<String,', 'public static void check(Map<String, Object> values) {'],
    ['public static void check(Map<String, ) {', 'Map<String,', 'Unclosed Map<String,', 'public static void check(Map<String, Object> values) {'],
    ['public static void check(String a, List<) {', 'List<', 'Unclosed List<', 'public static void check(String a, List<String> strings) {'],
    ['public static void check(List<List<) {', 'List<', 'Unclosed List<', 'public static void check(List<List<String>> strings) {'],
    ['public static void check(List {', 'List', 'Raw List in a method parameter', 'public static void check(List<String> strings) {'],
    ['public static void check(List requests {', 'List', 'Raw List', 'public static void check(List<String> requests) {'],
    ['public static void check(List<Req {', 'List<Req', 'Unclosed List<Req', 'public static void check(List<Request> requests) {'],
    ['public static void check(List<Acc {', 'List<Acc', 'Unclosed List<Acc', 'public static void check(List<Acc> accs) {'],
    ['public void check(List<Request {', 'List<Request', 'Unclosed List<Request', 'public void check(List<Request> requests) {'],
  ];
  for (const [header, flagged, message, fixedHeader] of cases) {
    const text = classWith(header);
    const found = breakers(text);
    assert.equal(found.length, 1, header);
    assert.equal(found[0].code, 'jorje-parse', header);
    assert.equal(text.slice(found[0].start, found[0].end), flagged, header);
    assert.ok(found[0].message.startsWith(message), `${header}\n  ${found[0].message}`);
    assert.ok(found[0].message.includes(` ${RETURN_CONSEQUENCE} Use `), found[0].message);
    const fixed = applyFix(text, found[0].fixes.find((f) => f.preferred));
    assert.equal(fixed.split('\n')[1].trim(), fixedHeader, header);
    assert.deepEqual(breakers(fixed), [], fixedHeader);
  }
  // With @InvocableMethod the same shapes crash the server: reported as crashes.
  for (const sig of ['(List<)', '(List< )', '(List {']) {
    const found = breakers(classWith(`@InvocableMethod public static void check${sig}${sig.endsWith('{') ? '' : ' {'}`));
    assert.deepEqual(found.map((b) => b.code), ['jorje-crash'], sig);
  }
});

test('return type quick fix picks the output class, with or without fields', () => {
  const titles = (header, classes) => {
    const text = ['public class Shape {', `    ${header}`, '    }', ...classes, '}', ''].join('\n');
    return breakers(text)[0].fixes.map((f) => `${f.preferred ? '*' : ''}${f.title}`);
  };
  const cls = (name, anno = '@InvocableVariable') => `    public class ${name} { ${anno ? `${anno} ` : ''}public String value; }`;
  const empty = (name) => `    public class ${name} { }`;
  const invocable = '@InvocableMethod public static List check(List<Request> requests) {';
  // The logged class: Response has no fields yet, Request does. Response wins.
  assert.deepEqual(titles(invocable, [cls('Request'), empty('Response')]),
    ['*Change the return type to List<Response>', 'Change the return type to List<Request>']);
  assert.deepEqual(titles(invocable, [cls('Request'), cls('Result')]),
    ['*Change the return type to List<Result>', 'Change the return type to List<Request>']);
  // An output class with @InvocableVariable fields beats one without.
  assert.deepEqual(titles(invocable, [empty('Response'), cls('FlowOutput')]),
    ['*Change the return type to List<FlowOutput>', 'Change the return type to List<Response>']);
  assert.deepEqual(titles(invocable, [cls('Request')]), ['*Change the return type to List<Request>']);
  assert.deepEqual(titles(invocable, []), ['*Change the return type to List<String> (no output class in this file)']);
  // Plain methods: output-like names only. Nested and Map shapes keep their structure.
  assert.deepEqual(titles('public static List<List> load() {', [empty('Result'), empty('Helper')]), ['*Change the return type to List<List<Result>>']);
  assert.deepEqual(titles('public static Map load() {', [empty('Result')]), ['*Change the return type to Map<String, Object>']);
  assert.deepEqual(titles('public static Set ids() {', []), ['*Change the return type to Set<String> (no output class in this file)']);
  // Applying the fix leaves nothing to report.
  const text = classWith('public static Map<String, List> load(String a) {');
  const [b] = breakers(text);
  assert.deepEqual(breakers(applyFix(text, b.fixes[0])), []);
});

test('comments and string literals are ignored', () => {
  const quiet = [
    '// @InvocableMethod\n    public static void check(List requests) {',
    '/* @InvocableMethod */ public static void check(List requests) {',
    '/** @AuraEnabled */\n    public static void check(Map requests) {',
    '@InvocableMethod public static void check(/* List */ List<Request> requests) {',
    "@InvocableMethod(label='check(List requests)' description='List<') public static void check(List<Request> requests) {",
    "@InvocableMethod(label='''List\n  raw''') public static void check(List<Request> requests) {",
  ];
  for (const header of quiet) assert.deepEqual(flaggedText(classWith(header)), [], header);
  const inStrings = [
    'public class Shape {',
    "    String a = '@InvocableMethod public static void check(List requests) {';",
    "    String b = 'global static void check(List< > x)';",
    '    /*',
    '    @InvocableMethod',
    '    public static void check(List requests) {',
    '    }',
    '    */',
    '    // @AuraEnabled public static void check(Map requests) {',
    '}',
  ].join('\n');
  assert.deepEqual(flaggedText(inStrings), []);
  // A comment between the type and the name, or inside the brackets, is skipped.
  assert.deepEqual(flaggedText(classWith('@InvocableMethod public static void check(List /* raw */ requests) {')), ['List']);
  assert.deepEqual(flaggedText(classWith('@InvocableMethod // flow action\n    /* note */ public static void check(List<Req /* typing */) {')), ['List<Req']);
});

test('multi-line signatures, annotation placement, inner classes and whitespace', () => {
  const multi = classWith('@InvocableMethod\n    public\n        static void check(\n        List\n            requests\n    ) {');
  const [m] = breakers(multi);
  assert.equal(multi.slice(m.start, m.end), 'List');
  assert.equal(multi.slice(0, m.start).split('\n').length, 5); // line of "List"
  // Only the type is rewritten: the line break before the name stays.
  assert.equal(m.fixes[0].title, 'Change to List<Request> requests');
  assert.equal(applyFix(multi, m.fixes[0]).includes('        List<Request>\n            requests\n    ) {'), true);

  const sameLine = classWith("@InvocableMethod(label='x') public\n    static void check(List\n        requests) {");
  assert.deepEqual(flaggedText(sameLine), ['List']);
  const annotationParams = classWith("@InvocableMethod(\n        label='Check'\n        description='d'\n    )\n    public static void check(List requests) {");
  assert.deepEqual(flaggedText(annotationParams), ['List']);
  const spaced = classWith('@InvocableMethod      public    static   void   check (   List     requests   )   {');
  assert.deepEqual(flaggedText(spaced), ['List']);
  // Annotated methods in inner classes, after other members.
  const inner = [
    'public with sharing class Outer {',
    '    public static Integer counter = 0;',
    "    public static final Map<String, List<String>> CODES = new Map<String, List<String>>{ 'a' => new List<String>{ 'x' } };",
    '    public String name { get; set; }',
    '    static { counter = 1; }',
    '    public void plain(List<Request> requests) { if (requests != null) { for (Request r : requests) { } } }',
    '    public class Helper {',
    '        @InvocableMethod',
    '        public void run(List items) {',
    '        }',
    '    }',
    '    public enum Tier { GOLD, SILVER }',
    '    public interface Api { void call(List<String> values); }',
    '    @AuraEnabled public static void load(Map options) { }',
    '    public class Request { @InvocableVariable public String caseNumber; }',
    '}',
  ].join('\n');
  assert.deepEqual(flaggedText(inner), ['List', 'Map']);
  // CRLF: same offsets as LF, shifted by the extra "\r" characters.
  const crlf = LOGGED.replace(/\n/g, '\r\n');
  const [c] = breakers(crlf);
  assert.equal(crlf.slice(c.start, c.end), 'List');
  assert.equal(applyFix(crlf, c.fixes[0]), LOGGED.replace('(List)', '(List<Request> requests)').replace(/\n/g, '\r\n'));
  // A second class in the same buffer, and two crashing methods in one class.
  const two = classWith('@InvocableMethod public static void a(List x) { }\n    @AuraEnabled public static void b(List<Req) {') + classWith('global static void c(Set s) {', 'global class Other {');
  assert.deepEqual(flaggedText(two), ['List', 'List<Req', 'Set']);
});

test('quick fix text for each shape', () => {
  const fixOf = (header, top) => {
    const text = classWith(header, top);
    const [b] = breakers(text);
    assert.ok(b, header);
    return {
      titles: b.fixes.map((f) => `${f.preferred ? '*' : ''}${f.title}`),
      results: b.fixes.map((f) => applyFix(text, f).split('\n')[1].trim()),
      text,
      b,
    };
  };
  const cases = [
    ['@InvocableMethod public static void check(List) {', ['*Change to List<Request> requests'], ['@InvocableMethod public static void check(List<Request> requests) {']],
    ['@InvocableMethod public static void check(List requests) {', ['*Change to List<Request> requests'], ['@InvocableMethod public static void check(List<Request> requests) {']],
    ['@InvocableMethod public static void check(list items) {', ['*Change to list<Request> items'], ['@InvocableMethod public static void check(list<Request> items) {']],
    ['@InvocableMethod public static void check(List<List> requests) {', ['*Change to List<List<Request>> requests'], ['@InvocableMethod public static void check(List<List<Request>> requests) {']],
    ['@InvocableMethod public static void check(List<> requests) {', ['*Change to List<Request> requests'], ['@InvocableMethod public static void check(List<Request> requests) {']],
    ['@InvocableMethod public static void check(List< ) {', ['*Change to List<Request> requests'], ['@InvocableMethod public static void check(List<Request> requests) {']],
    ['@InvocableMethod public static void check(List<Req) {', ['*Change to List<Request> requests'], ['@InvocableMethod public static void check(List<Request> requests) {']],
    ['@InvocableMethod public static void check(List<Request) {', ['*Change to List<Request> requests'], ['@InvocableMethod public static void check(List<Request> requests) {']],
    ['@InvocableMethod public static void check(List<List<Req) {', ['*Change to List<List<Request>> requests'], ['@InvocableMethod public static void check(List<List<Request>> requests) {']],
    // "R" fits both inner classes: the @InvocableVariable one is preferred.
    ['@InvocableMethod public static void check(List<R) {', ['*Change to List<Request> requests', 'Change to List<Response> responses'],
      ['@InvocableMethod public static void check(List<Request> requests) {', '@InvocableMethod public static void check(List<Response> responses) {']],
    // A name that is not declared in this file is closed as typed.
    ['@InvocableMethod public static void check(List<Acc) {', ['*Change to List<Acc> accs'], ['@InvocableMethod public static void check(List<Acc> accs) {']],
    // Parameter list not closed yet: the ")" comes with the fix.
    ['@InvocableMethod public static void check(List {', ['*Change to List<Request> requests'], ['@InvocableMethod public static void check(List<Request> requests) {']],
    ['@InvocableMethod public static void check(List<String, String> requests) {', ['*Change to List<String> requests'], ['@InvocableMethod public static void check(List<String> requests) {']],
    // A Map does not use the element type, so the title has no "no class" note.
    ['@AuraEnabled public static void check(Map requests) {', ['*Change to Map<String, Object> requests'],
      ['@AuraEnabled public static void check(Map<String, Object> requests) {']],
    ['@AuraEnabled public static void check(String strings, List) {', ['*Change to List<String> strings2 (no class with @AuraEnabled fields in this file)'],
      ['@AuraEnabled public static void check(String strings, List<String> strings2) {']],
    ['@AuraEnabled public static void check(Map<String, List> byKey) {', ['*Change to Map<String, List<String>> byKey (no class with @AuraEnabled fields in this file)'],
      ['@AuraEnabled public static void check(Map<String, List<String>> byKey) {']],
    ['@AuraEnabled public static void check(Map<String) {', ['*Change to Map<String, Object> values'], ['@AuraEnabled public static void check(Map<String, Object> values) {']],
    ['public static void check(List<String, > xs) {', ['*Change to List<String> xs'], ['public static void check(List<String> xs) {']],
    ['public static void check(Map< > m) {', ['*Change to Map<String, Object> m'], ['public static void check(Map<String, Object> m) {']],
  ];
  for (const [header, titles, results] of cases) {
    const got = fixOf(header);
    assert.deepEqual(got.titles, titles, header);
    assert.deepEqual(got.results, results, header);
  }
  // global: the enclosing global class is never offered as the element type.
  const g = fixOf('global static void check(List items) {', 'global with sharing class Shape {');
  assert.deepEqual(g.titles, ['*Change to List<String> items (no other global class in this file)']);
  // Every fix leaves a signature the detector accepts.
  for (const [header] of cases) {
    const { text, b } = fixOf(header);
    for (const f of b.fixes) assert.deepEqual(breakers(applyFix(text, f)), [], `${header} -> ${f.title}`);
  }
});

test('quick fix picks the input class: @InvocableVariable fields, input-like name, or the only one', () => {
  const withClasses = (classes, header = '@InvocableMethod public static void check(List requests) {') => {
    const text = ['public class Shape {', `    ${header}`, '    }', ...classes, '}', ''].join('\n');
    return breakers(text)[0].fixes.map((f) => `${f.preferred ? '*' : ''}${f.title}`);
  };
  const cls = (name, anno = '@InvocableVariable') => `    public class ${name} { ${anno ? `${anno} ` : ''}public String value; }`;
  // Input-like beats output-like.
  assert.deepEqual(withClasses([cls('Output'), cls('Input')]), ['*Change to List<Input> requests', 'Change to List<Output> requests']);
  assert.deepEqual(withClasses([cls('FlowResult'), cls('FlowRequest')]), ['*Change to List<FlowRequest> requests', 'Change to List<FlowResult> requests']);
  // Two input-like classes: both offered, none preferred (ambiguous).
  assert.deepEqual(withClasses([cls('Request'), cls('Input')]), ['Change to List<Request> requests', 'Change to List<Input> requests']);
  // The only @InvocableVariable class wins whatever its name; classes without such fields are not candidates.
  assert.deepEqual(withClasses([cls('Request', null), cls('Result')]), ['*Change to List<Result> requests']);
  // Nothing fits: String, and the title says why.
  assert.deepEqual(withClasses([cls('Request', null)]), ['*Change to List<String> requests (no class with @InvocableVariable fields in this file)']);
  // @AuraEnabled methods look for @AuraEnabled wrappers instead.
  assert.deepEqual(withClasses([cls('Request'), cls('Filter', '@AuraEnabled')], '@AuraEnabled public static void check(List filters) {'),
    ['*Change to List<Filter> filters']);
  // Annotation parameters and properties count too.
  assert.deepEqual(withClasses(['    public class Payload { @InvocableVariable(required=true label=\'x\') public String v { get; set; } }']), ['*Change to List<Payload> requests']);
});

// A class with "members" and a probe method, shaped like the jorje review
// cases K16 / K17 (global constructors, global interfaces).
function globalClass(members, top = 'global with sharing class Shape {') {
  return [
    top,
    ...members.map((m) => `    ${m}`),
    '    public static void probe() {',
    '        Request r = new Request();',
    '    }',
    '    public class Request {',
    '        @InvocableVariable',
    '        public String caseNumber;',
    '    }',
    '}',
    '',
  ].join('\n');
}

test('global constructors and methods of a global interface are checked like global methods', () => {
  const PUBLIC = 'public with sharing class Shape {';
  const cases = [
    // [members, class header or undefined, flagged text, message start]  (jorje review case)
    [['global Shape(List items) {', '}'], undefined, 'List', 'Raw List in a global constructor parameter'], // K16
    [['global Shape(Set items) {', '}'], undefined, 'Set', 'Raw Set in a global constructor parameter'], // K16d
    [['global Shape(Map items) {', '}'], undefined, 'Map', 'Raw Map in a global constructor parameter'], // K16e
    [['global Shape(List<Req) {', '}'], undefined, 'List<Req', 'Unclosed List<Req in a global constructor parameter'], // K16g
    [['global Shape(List<List> items) {', '}'], undefined, 'List', 'Raw List in a global constructor parameter'], // K16h
    [['global Shape(String a, Map m) {', '}'], undefined, 'Map', 'Raw Map in a global constructor'], // K16j
    [['global Shape(Set<String, String> s) {', '}'], undefined, 'Set<String, String>', 'Set with 2 type arguments (Set takes 1) in a global constructor'], // K16k
    [['global Shape(List items) {', '}'], PUBLIC, 'List', 'Raw List in a global constructor'], // K16i
    [['global class Inner {', '    global Inner(List items) {', '    }', '}'], undefined, 'List', 'Raw List in a global constructor'], // K16l
    [['global interface Api {', '    void m(List items);', '}'], undefined, 'List', 'Raw List in a global interface method parameter'], // K17
    [['global interface Api {', '    void m(Set items);', '}'], undefined, 'Set', 'Raw Set in a global interface method parameter'], // K17d
    [['global interface Api {', '    void m(List<Req);', '}'], undefined, 'List<Req', 'Unclosed List<Req in a global interface method parameter'], // K17f
    [['global interface Api {', '    void m(List<List> items);', '}'], undefined, 'List', 'Raw List in a global interface method'], // K17h
    [['global interface Api {', '    void m(Map<String> items);', '}'], undefined, 'Map<String>', 'Map with 1 type argument (Map takes 2) in a global interface method'], // K17i
    [['global interface Api {', '    void ok(List<String> a);', '    String m(String a, Map b);', '}'], undefined, 'Map', 'Raw Map in a global interface method'], // K17j
    [['global interface Api {', '    void m(List items);', '}'], PUBLIC, 'List', 'Raw List in a global interface method'], // K17g
  ];
  for (const [members, top, flagged, message] of cases) {
    const text = globalClass(members, top);
    const found = breakers(text);
    assert.equal(found.length, 1, members.join(' '));
    assert.equal(found[0].code, 'jorje-crash', members.join(' '));
    assert.equal(text.slice(found[0].start, found[0].end), flagged, members.join(' '));
    assert.ok(found[0].message.startsWith(message), `${members.join(' ')}\n  ${found[0].message}`);
    assert.ok(found[0].message.includes(` ${CONSEQUENCE} Use `), found[0].message);
    // The preferred fix leaves nothing to report.
    const fix = found[0].fixes.find((f) => f.preferred);
    assert.ok(fix, members.join(' '));
    assert.deepEqual(breakers(applyFix(text, fix)), [], `${members.join(' ')} -> ${fix.title}`);
  }
  // A top-level global interface (its own file) too.
  const top = 'global interface Api {\n    void m(List items);\n}\n';
  assert.deepEqual(flaggedText(top), ['List']);
  // Quick fix: the enclosing global types are never the element type.
  const [k16] = breakers(globalClass(['global Shape(List items) {', '}']));
  assert.deepEqual(k16.fixes.map((f) => `${f.preferred ? '*' : ''}${f.title}`), ['*Change to List<String> items (no other global class in this file)']);
  const [k16g] = breakers(globalClass(['global Shape(List<Req) {', '}']));
  assert.deepEqual(k16g.fixes.map((f) => `${f.preferred ? '*' : ''}${f.title}`), ['*Change to List<Request> requests']);

  // Measured clean: typed collections, public constructors and public
  // interfaces of a global class, an @InvocableMethod constructor.
  const quiet = [
    [['global Shape(List<String> items) {', '}']], // K16c
    [['public Shape(List items) {', '}']], // K16f
    [['global interface Api {', '    void m(List<String> items);', '}']], // K17c
    [['public interface Api {', '    void m(List items);', '}']], // K17e
    [['@InvocableMethod', 'public Shape(List requests) {', '}'], PUBLIC], // K4
    [['@AuraEnabled', 'public Shape(List requests) {', '}'], PUBLIC],
  ];
  for (const [members, top2] of quiet) assert.deepEqual(flaggedText(globalClass(members, top2)), [], members.join(' '));
  assert.deepEqual(flaggedText('public interface Api {\n    void m(List items);\n}\n'), []); // K17u
});

test('quick fixes keep what was typed: Map slots, comments and line breaks', () => {
  const cases = [
    // [method header, class header or undefined, preferred fix title, fixed header]
    ['public void run(Map<,Account> accountsById) {', undefined, 'Change to Map<String, Account> accountsById', 'public void run(Map<String, Account> accountsById) {'],
    ['public void run(Map<Account, > byKey) {', undefined, 'Change to Map<Account, Object> byKey', 'public void run(Map<Account, Object> byKey) {'],
    ['@AuraEnabled public static void run(Map<, List<Account>> m) {', undefined, 'Change to Map<String, List<Account>> m', '@AuraEnabled public static void run(Map<String, List<Account>> m) {'],
    ['global static void m(Map<,Request> byKey) {', 'global with sharing class Shape {', 'Change to Map<String, Request> byKey', 'global static void m(Map<String, Request> byKey) {'],
    ['public void run(Map<,Req) {', undefined, 'Change to Map<String, Request> values', 'public void run(Map<String, Request> values) {'],
    ['public void run(Map<A,,B> m) {', undefined, 'Change to Map<A, B> m', 'public void run(Map<A, B> m) {'],
    // Comments between the type and the name, or before the ")", stay.
    ['@InvocableMethod public static void check(/* x */ List /* y */ requests) {', undefined, 'Change to List<Request> requests', '@InvocableMethod public static void check(/* x */ List<Request> /* y */ requests) {'],
    ['@InvocableMethod public static void check(List<Req /* typing */) {', undefined, 'Change to List<Request> requests', '@InvocableMethod public static void check(List<Request> requests /* typing */) {'],
    ['@InvocableMethod public static void check(List /* none */ ) {', undefined, 'Change to List<Request> requests', '@InvocableMethod public static void check(List<Request> requests /* none */) {'],
    ['public static void check(List /* c */ requests {', undefined, 'Change to List<String> requests', 'public static void check(List<String> /* c */ requests) {'],
    ['public static void check(List /* c */ {', undefined, 'Change to List<String> strings', 'public static void check(List<String> strings /* c */) {'],
    // A "[]" on a rebuilt generic type is dropped: jorje rejects
    // "List<Response>[] check(" (measured, K31 / K38) like a raw List.
    ['@InvocableMethod public static void check(List[] requests) {', undefined, 'Change to List<Request> requests', '@InvocableMethod public static void check(List<Request> requests) {'],
    ['public static List[] check(String a) {', undefined, 'Change the return type to List<Response>', 'public static List<Response> check(String a) {'],
    ['public static List<List>[] check(String a) {', undefined, 'Change the return type to List<List<Response>>', 'public static List<List<Response>> check(String a) {'],
    ['public static List /* c */ check(String a) {', undefined, 'Change the return type to List<Response>', 'public static List<Response> /* c */ check(String a) {'],
  ];
  for (const [header, top, title, fixedHeader] of cases) {
    const text = classWith(header, top);
    const found = breakers(text);
    assert.equal(found.length, 1, header);
    const fix = found[0].fixes.find((f) => f.preferred);
    assert.ok(fix, `${header}: ${found[0].fixes.map((f) => f.title)}`);
    assert.equal(fix.title, title, header);
    const fixed = applyFix(text, fix);
    assert.equal(fixed.split('\n')[1].trim(), fixedHeader, header);
    assert.deepEqual(breakers(fixed), [], fixedHeader);
  }
  // A line comment before the ")" or the body keeps its line break: the ")"
  // must not end up commented out (measured K42: "strings// typing) {").
  const lineComments = [
    ['public static void check(List<// typing\n    ) {', 'public static void check(List<String> strings// typing\n    ) {'],
    ['@InvocableMethod public static void check(List // flow input\n    ) {', '@InvocableMethod public static void check(List<Request> requests // flow input\n    ) {'],
    ['public static void check(List requests // note\n    {', 'public static void check(List<String> requests // note\n    ) {'],
    ['public static void check(List /* a */ // b\n    {', 'public static void check(List<String> strings /* a */ // b\n    ) {'],
    ['public static void check(List< // a /* b\n    ) {', 'public static void check(List<String> strings // a /* b\n    ) {'],
    ['public static void check(List< /* // */ ) {', 'public static void check(List<String> strings /* // */) {'],
  ];
  for (const [header, fixedHeader] of lineComments) {
    const text = classWith(header);
    const found = breakers(text);
    assert.equal(found.length, 1, header);
    const fixed = applyFix(text, found[0].fixes.find((f) => f.preferred));
    assert.ok(fixed.includes(`    ${fixedHeader}\n`), `${header}\n${fixed}`);
    assert.deepEqual(breakers(fixed), [], fixedHeader);
  }
  // Multi-line: the edit is the type alone, the rest of the lines is untouched.
  const multi = classWith('@InvocableMethod public static void check(\n        Map<,Request> // key missing\n            byKey) {', 'public class Shape {');
  const [m] = breakers(multi);
  assert.deepEqual(m.fixes.map((f) => [f.title, f.edit.newText]), [['Change to Map<String, Request> byKey', 'Map<String, Request>']]);
  assert.ok(applyFix(multi, m.fixes[0]).includes('        Map<String, Request> // key missing\n            byKey) {'));
});

test('the pre-check never hides a flagged shape, and a fix never changes the code after it', () => {
  // Each alone in a file with no other hint word (classWith adds none). The
  // old regexes on the raw text missed all of them.
  const alone = [
    ['public static List /* c */ check(String a) {', 'List'], // K30
    ['public static List[] check(String a) {', 'List'], // K31
    ['public static List [ ] check(String a) {', 'List'],
    ['public static Map<String, List[]> check(String a) {', 'List'],
    ['public static Map<String, List /* c */> check(String a) {', 'List'],
    ['@/* c */HttpPost public static void check(Map requests) {', 'Map'],
    ['public void check(Map<String,,Account> m) {', 'Map<String,,Account>'],
    ['public void check(List</* c */>) {', 'List</* c */>'],
    ['public static void check(List<// typing\n    ) {', 'List<'],
  ];
  for (const [header, flagged] of alone) {
    const text = classWith(header);
    assert.deepEqual(flaggedText(text), [flagged], header);
    // The same result with an unrelated hint word elsewhere in the file.
    const noisy = classWith(header).replace('    public class Response {', '    // global\n    global void g() {}\n    public class Response {');
    assert.deepEqual(flaggedText(noisy), [flagged], `${header} (+ global member)`);
  }
  // Hint words only inside comments and strings do not count: nothing to scan.
  const quiet = classWith("public static void check(List<String> a) { String s = 'global (List {'; }").replace('{\n    public static', '{\n    // @InvocableMethod check(List) List check( <,> (List {\n    public static');
  assert.deepEqual(breakers(quiet), []);

  // Seeded fuzz: random signatures with comments sprinkled between tokens.
  // With and without the pre-check the results must be identical.
  let seed = 20261014;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = (list) => list[rnd(list.length)];
  const annotations = ['', '@InvocableMethod ', '@AuraEnabled ', '@HttpPost ', '@/* a */HttpGet ', "@InvocableMethod(label='(List {') ", '@TestVisible ', '// @InvocableMethod\n    '];
  const modifiers = ['public static ', 'global static ', 'webservice static ', 'public ', 'global ', 'private ', ''];
  const returns = ['void', 'List', 'List[]', 'List /* c */', 'List<String>', 'Map<String, List>', 'List<List[]>', 'List<>', 'List< >', 'Set', 'List<Res', 'Map<,X>', 'String', 'List<List>[]'];
  const types = ['List', 'List<', 'List< ', 'List<Req', 'List<List>', 'List<>', 'List< >', 'Map', 'Map<,X>', 'Map<String,,X>', 'Map<String,',
    'Set<String, String>', 'List<String>', 'String', 'List[]', 'List /* c */', "List/*'(*/", 'List<List<Req', 'Set<List>', 'Map<String, List>',
    'List<// typing\n        ', 'List // raw\n        ', 'Map<String, // value\n        '];
  const names = ['', ' requests', ' /* c */ items', '\n        rows', ' requests // note\n        '];
  const closers = [') {', ') { }', ' {', ');', ')', ' /* ) */ {', ") { String s = '(List {'; }", ') // done\n    {'];
  const containers = [
    (m) => `public class Shape {\n    ${m}\n    }\n}`,
    (m) => `global class Shape {\n    ${m}\n    }\n}`,
    (m) => `global class Shape {\n    global interface Api {\n        ${m.replace(/\{.*$/s, ';')}\n    }\n}`,
    (m) => `public class Shape {\n    public interface Api {\n        ${m.replace(/\{.*$/s, ';')}\n    }\n}`,
  ];
  const sprinkle = (s) => s.replace(/ /g, () => {
    const r = rnd(40);
    return r < 3 ? ' /* x */ ' : r < 5 ? ' // x\n        ' : r < 6 ? '\n        ' : ' ';
  });
  // Code of "text" from "from" on: comments and strings dropped, whitespace collapsed.
  const codeFrom = (text, from) => {
    let out = '';
    let i = from;
    for (const r of lib.analyze(text).regions) {
      if (r.end <= i) continue;
      if (r.start > i) out += text.slice(i, r.start);
      i = r.end;
    }
    return (out + text.slice(i)).replace(/\s+/g, ' ').trim();
  };
  let flagged = 0;
  let fixes = 0;
  const total = 3000;
  for (let k = 0; k < total; k++) {
    const params = [];
    for (let p = 0, count = 1 + rnd(2); p < count; p++) params.push(`${pick(types)}${pick(names)}`);
    const ctor = rnd(5) === 0;
    const head = `${pick(annotations)}${pick(modifiers)}${ctor ? 'Shape' : `${pick(returns)} check`}(${params.join(', ')}${pick(closers)}`;
    const text = `${pick(containers)(sprinkle(head))}\n    public class Request { @InvocableVariable public String caseNumber; }\n`;
    const full = lib.findCompletionBreakers(text, undefined, { precheck: false });
    assert.deepEqual(lib.findCompletionBreakers(text), full, text);
    if (full.length > 0) flagged++;
    // A fix rewrites its own range only: the code after it is the same, so
    // nothing gets commented out or swallowed.
    for (const b of full) {
      for (const f of b.fixes) {
        fixes++;
        const fixed = applyFix(text, f);
        assert.equal(codeFrom(fixed, f.edit.start + f.edit.newText.length), codeFrom(text, f.edit.end), `${f.title}\n${text}\n---\n${fixed}`);
      }
    }
  }
  assert.ok(flagged > total / 3 && flagged < total, `${flagged} of ${total} flagged`);
  return `${alone.length} shapes alone, ${total} fuzzed signatures (${flagged} flagged, ${fixes} fixes applied)`;
});

test('pre-check stays linear: an unclosed "(" above 5000 List fields', () => {
  // The old pre-check regex rescanned the rest of the file for every List
  // after an unclosed "(": about 650 ms here, on the extension host.
  const file = (opener, lineCount) => {
    const lines = ['public class Dto {', opener];
    for (let k = 0; k < lineCount; k++) lines.push(`    public List<String> values${k};`);
    lines.push('}');
    return lines.join('\n');
  };
  const openers = {
    comment: '    // Fields generated from the sample payload (see ticket ABC-123',
    string: "    String note = 'see (ticket ABC-123';",
    code: '    public void run(',
  };
  lib.findCompletionBreakers(file(openers.code, 200)); // JIT warm-up
  const notes = [];
  for (const [where, opener] of Object.entries(openers)) {
    const text = file(opener, 5000);
    const a = lib.analyze(text);
    const t0 = process.hrtime.bigint();
    const found = lib.findCompletionBreakers(text, a);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.deepEqual(found, [], where);
    assert.ok(ms < 50, `${where}: took ${ms.toFixed(2)} ms`);
    notes.push(`${where} ${ms.toFixed(2)} ms`);
  }
  return notes.join(', ');
});

function syntheticInvocable(lineCount) {
  const out = ['global with sharing class BigActions {'];
  let k = 0;
  while (out.length < lineCount - 6) {
    out.push(`    // Section ${k}: @InvocableMethod check(List raw) lives only in this comment.`);
    out.push(`    @InvocableMethod(label='Action ${k}' description='List<Request${k}> in, List<Result${k}> out')`);
    out.push(`    public static List<Result${k}> run${k}(List<Request${k}> requests) {`);
    out.push(`        List<Result${k}> out = new List<Result${k}>();`);
    out.push(`        for (Request${k} r : requests) { out.add(new Result${k}()); }`);
    out.push('        return out;');
    out.push('    }');
    out.push(`    @AuraEnabled(cacheable=true) public static Map<String, List<Request${k}>> load${k}(Map<String, Object> options) { return null; }`);
    out.push(`    global static void push${k}(Set<Id> ids, List<List<String>> rows) { }`);
    out.push(`    public class Request${k} { @InvocableVariable(required=true) public String caseNumber; @InvocableVariable public Integer count; }`);
    out.push(`    public class Result${k} { @InvocableVariable public Boolean eligible; }`);
    k++;
  }
  out.push('    @InvocableMethod');
  out.push('    public static void broken(List) {');
  out.push('    }');
  out.push('}');
  return { text: out.join('\n'), blocks: k, lines: out.length };
}

// A large service class as it is really written: annotated actions with
// bodies, inner request / result classes.
function syntheticService(lineCount) {
  const out = ['global with sharing class CaseService {'];
  let k = 0;
  while (out.length < lineCount - 5) {
    out.push('    /**', `     * Action ${k}: one result per request.`, `     * @param requests List<Request${k}> from the flow`, '     */');
    out.push(k % 2 === 0 ? `    @InvocableMethod(label='Action ${k}' description='Checks ${k}')` : '    @AuraEnabled(cacheable=true)');
    out.push(`    public static List<Result${k}> run${k}(List<Request${k}> requests) {`);
    out.push(`        List<Result${k}> results = new List<Result${k}>();`);
    out.push('        Set<Id> ids = new Set<Id>();');
    out.push(`        for (Request${k} r : requests) { ids.add(r.recordId); }`);
    out.push('        Map<Id, Case> byId = new Map<Id, Case>([SELECT Id, Priority FROM Case WHERE Id IN :ids]);');
    for (let s = 0; s < 6; s++) {
      out.push(`        // step ${s}: rule ${s} for every request`);
      out.push(`        for (Request${k} r : requests) {`);
      out.push('            Case c = byId.get(r.recordId);');
      out.push(`            Result${k} res = new Result${k}();`);
      out.push(`            res.eligible = c != null && c.Priority == 'High' && r.count > ${s};`);
      out.push(`            res.message = res.eligible ? 'ok' : 'Rule ${s} failed for ' + r.caseNumber;`);
      out.push('            results.add(res);');
      out.push('        }');
    }
    out.push('        return results;', '    }');
    out.push(`    global class Request${k} {`, '        @InvocableVariable(required=true) global String caseNumber;',
      '        @InvocableVariable global Id recordId;', '        @InvocableVariable global Integer count;', '    }');
    out.push(`    global class Result${k} {`, '        @InvocableVariable @AuraEnabled global Boolean eligible;',
      '        @InvocableVariable @AuraEnabled global String message;', '    }');
    k++;
  }
  out.push('    @InvocableMethod', '    public static void broken(List) {', '    }', '}');
  return { text: out.join('\n'), methods: k, lines: out.length };
}

test('5000-line files: crash check under 50 ms (realistic), linear on the worst case', () => {
  // Realistic: annotated actions with real bodies. The bodies are skipped
  // without tokenizing (analyze() records them), so this stays cheap.
  const service = syntheticService(5000);
  const sa = lib.analyze(service.text);
  const t0 = process.hrtime.bigint();
  const found = lib.findCompletionBreakers(service.text, sa);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(found.length, 1);
  assert.equal(service.text.slice(found[0].start, found[0].end), 'List');
  // Many equal @InvocableVariable classes: "Request<k>" ranks first (input-like
  // name), at most four alternatives, none preferred.
  assert.equal(found[0].fixes[0].title, 'Change to List<Request0> request0s');
  assert.equal(found[0].fixes.length, 4);
  assert.ok(found[0].fixes.every((f) => !f.preferred));
  assert.ok(ms < 50, `took ${ms.toFixed(2)} ms`);

  // Worst case: every line a declaration (1800 annotated methods, 900
  // classes). Only a guard against non-linear behaviour: the first run
  // includes the JIT warm-up of every function involved.
  const dense = syntheticInvocable(5000);
  const da = lib.analyze(dense.text);
  const t1 = process.hrtime.bigint();
  assert.equal(lib.findCompletionBreakers(dense.text, da).length, 1);
  const denseMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(denseMs < 100, `dense file took ${denseMs.toFixed(2)} ms`);

  // Files without any trigger word skip the scan entirely.
  const plain = syntheticApex(5000).text;
  const t2 = process.hrtime.bigint();
  assert.deepEqual(lib.findCompletionBreakers(plain), []);
  const skip = Number(process.hrtime.bigint() - t2) / 1e6;
  return `service ${service.lines} lines / ${service.methods} actions ${ms.toFixed(2)} ms; ` +
    `dense ${dense.lines} lines ${denseMs.toFixed(2)} ms; plain ${skip.toFixed(2)} ms`;
});

test('crash check never throws on partial input (every prefix of a typed class)', () => {
  const sample = [
    LOGGED,
    classWith("@InvocableMethod(label='a\\'b' description='''x''') public static void check(List<List<Req, String b) {"),
    classWith('global static void check(Map<String, List< >> m, Set<,> s) {', 'global class G {'),
    '@\n@Invocable\n(List\n<\n>\n}}}{{{\'\'\'',
  ].join('\n');
  for (let k = 0; k <= sample.length; k++) lib.findCompletionBreakers(sample.slice(0, k));
  for (const text of [null, undefined, '', '@', '@InvocableMethod', 'global', '(List', ')', 'List<', 'class', 'global class {', '{ @AuraEnabled static void f(Map }']) {
    assert.ok(Array.isArray(lib.findCompletionBreakers(text)));
  }
  assert.deepEqual(lib.findCompletionBreakers(null), []);
});

// ---------------------------------------------------------- extension.js

function loadExtension(openDocuments = []) {
  const registered = [];
  const listeners = [];
  const opened = [];
  const changed = [];
  const codeActionProviders = [];
  const collections = [];
  const settings = {};
  const configCalls = [];
  const fake = {
    CompletionItemKind: { Class: 6, Interface: 7, Enum: 12 },
    CompletionItem: class CompletionItem {
      constructor(label, kind) {
        this.label = label;
        this.kind = kind;
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    Diagnostic: class Diagnostic {
      constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
      }
    },
    Range: class Range {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    CodeActionKind: { QuickFix: 'quickfix' },
    CodeAction: class CodeAction {
      constructor(title, kind) {
        this.title = title;
        this.kind = kind;
      }
    },
    WorkspaceEdit: class WorkspaceEdit {
      constructor() {
        this.replacements = [];
      }
      replace(uri, range, newText) {
        this.replacements.push({ uri, range, newText });
      }
    },
    languages: {
      registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
        registered.push({ selector, provider, triggerCharacters });
        return { dispose() {} };
      },
      registerCodeActionsProvider(selector, provider, metadata) {
        codeActionProviders.push({ selector, provider, metadata });
        return { dispose() {} };
      },
      createDiagnosticCollection(name) {
        const byUri = new Map();
        const collection = {
          name,
          byUri,
          set(uri, list) { byUri.set(uri.toString(), list); },
          delete(uri) { byUri.delete(uri.toString()); },
          get(uri) { return byUri.get(uri.toString()); },
          dispose() { byUri.clear(); },
        };
        collections.push(collection);
        return collection;
      },
    },
    workspace: {
      textDocuments: openDocuments,
      onDidOpenTextDocument(fn) {
        opened.push(fn);
        return { dispose() {} };
      },
      onDidChangeTextDocument(fn) {
        changed.push(fn);
        return { dispose() {} };
      },
      onDidCloseTextDocument(fn) {
        listeners.push(fn);
        return { dispose() {} };
      },
      getConfiguration(section, scope) {
        configCalls.push({ section, scope });
        if (settings.throwOnRead) throw new Error('config boom');
        return {
          get(key, fallback) {
            const value = settings[`${section}.${key}`];
            return value === undefined ? fallback : value;
          },
        };
      },
    },
  };
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
  };
  require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: fake };
  try {
    delete require.cache[require.resolve('../src/local-types/extension')];
    const ext = require('../src/local-types/extension');
    const context = { subscriptions: [] };
    ext.activate(context);
    return {
      ext, fake, registered, listeners, opened, changed, codeActionProviders,
      diagnostics: collections[0], context, settings, configCalls,
    };
  } finally {
    Module._resolveFilename = resolve;
  }
}

// Minimal vscode.Uri: scheme, decoded path, toString().
function fakeUri(uri) {
  const colon = uri.indexOf(':');
  const rest = uri.slice(colon + 1);
  const path = decodeURIComponent(rest.startsWith('//') ? rest.slice(rest.indexOf('/', 2)) : rest);
  return { scheme: uri.slice(0, colon), path, toString: () => uri };
}

function fakeDocument(source, version = 1, uri = 'file:///c%3A/force-app/CheckLedgerEligibility.cls', languageId = 'apex') {
  const { text, offset } = source.includes('§') ? cursor(source) : { text: source, offset: 0 };
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  let line = 0;
  while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++;
  const doc = {
    uri: fakeUri(uri),
    languageId,
    version,
    getTextCalls: 0,
    getText() {
      doc.getTextCalls++;
      return text;
    },
    offsetAt(pos) {
      return lineStarts[pos.line] + pos.character;
    },
    positionAt(off) {
      let l = 0;
      while (l + 1 < lineStarts.length && lineStarts[l + 1] <= off) l++;
      return { line: l, character: off - lineStarts[l] };
    },
  };
  return { doc, position: { line, character: offset - lineStarts[line] } };
}

test('extension registers one provider for apex file + untitled, no trigger characters', () => {
  const { registered, listeners, opened, changed, codeActionProviders, diagnostics, context } = loadExtension();
  assert.equal(registered.length, 1);
  assert.deepEqual(registered[0].selector, [
    { language: 'apex', scheme: 'file' },
    { language: 'apex', scheme: 'untitled' },
  ]);
  assert.deepEqual(registered[0].triggerCharacters, []);
  assert.equal(listeners.length, 1);
  // completion + code actions + diagnostic collection + open / change / close
  assert.equal(codeActionProviders.length, 1);
  assert.deepEqual(codeActionProviders[0].selector, registered[0].selector);
  assert.deepEqual(codeActionProviders[0].metadata, { providedCodeActionKinds: ['quickfix'] });
  assert.equal(diagnostics.name, 'virga');
  assert.equal(opened.length, 1);
  assert.equal(changed.length, 1);
  assert.equal(context.subscriptions.length, 6);
});

test('extension maps candidates to CompletionItems with kind, detail and sortText', () => {
  const { registered, fake } = loadExtension();
  const provider = registered[0].provider;
  const src = LEDGER.replace('Resp§', '§').replace('public class Request {', 'public interface Marker { }\n    public enum Tier { GOLD }\n    public class Request {');
  const { doc, position } = fakeDocument(src, 1, 'untitled:Untitled-1');
  const items = provider.provideCompletionItems(doc, position, { isCancellationRequested: false });
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
  assert.deepEqual(Object.keys(byLabel).sort(), ['CheckLedgerEligibility', 'Marker', 'Request', 'Response', 'Tier']);
  assert.equal(byLabel.CheckLedgerEligibility.detail, 'class in this file');
  assert.equal(byLabel.Response.kind, fake.CompletionItemKind.Class);
  assert.equal(byLabel.Marker.kind, fake.CompletionItemKind.Interface);
  assert.equal(byLabel.Tier.kind, fake.CompletionItemKind.Enum);
  assert.equal(byLabel.Response.detail, 'inner class of CheckLedgerEligibility');
  assert.equal(byLabel.Response.sortText, 'Response');
});

test('extension returns undefined for member access, comments, strings, SOQL and cancellation', () => {
  const { registered } = loadExtension();
  const provider = registered[0].provider;
  // Expected labels, or undefined. The document is CheckLedgerEligibility.cls,
  // so its own top-level class is left to the language server.
  const cases = [
    ['out[0].§', undefined],
    ['out[0].mess§', undefined],
    ['// Resp§', undefined],
    ["String s = 'Resp§';", undefined],
    ['List<Account> b = [SELECT Id FROM Re§];', undefined],
    ['List<Account> a = [SELECT Id, Re§ FROM Account];', undefined],
    ['List<Account> c = [SELECT Id FROM Account WHERE Name = :Re§];', RESP],
    ['List<Response> r = new §', RESP],
  ];
  cases.forEach(([statement, expected], index) => {
    const { doc, position } = fakeDocument(inMethod(statement), index + 1);
    const items = provider.provideCompletionItems(doc, position, {});
    assert.deepEqual(items && items.map((i) => i.label).sort(), expected, statement);
  });
  const { doc, position } = fakeDocument(inMethod('Resp§'), 99);
  assert.equal(provider.provideCompletionItems(doc, position, { isCancellationRequested: true }), undefined);
});

test('extension caches the scan per uri + version', () => {
  const { registered, listeners } = loadExtension();
  const provider = registered[0].provider;
  const v1 = fakeDocument(inMethod('Resp§'), 1);
  provider.provideCompletionItems(v1.doc, v1.position, {});
  provider.provideCompletionItems(v1.doc, v1.position, {});
  assert.equal(v1.doc.getTextCalls, 1, 'same version must reuse the scan');
  const v2 = fakeDocument(inMethod('new Resp§'), 2);
  const items = provider.provideCompletionItems(v2.doc, v2.position, {});
  assert.equal(v2.doc.getTextCalls, 1, 'new version must rescan');
  assert.deepEqual(items.map((i) => i.label).sort(), RESP);
  listeners[0](v2.doc);
  provider.provideCompletionItems(v2.doc, v2.position, {});
  assert.equal(v2.doc.getTextCalls, 2, 'closing the document must drop its cache entry');
});

test("extension leaves the file's own top-level class to the language server for saved files only", () => {
  const { registered } = loadExtension();
  const provider = registered[0].provider;
  let version = 0;
  const labels = (uri, statement = '§') => {
    const { doc, position } = fakeDocument(inMethod(statement), ++version, uri);
    const items = provider.provideCompletionItems(doc, position, {});
    return items && items.map((i) => i.label).sort();
  };
  const own = 'file:///c%3A/force-app/main/default/classes/CheckLedgerEligibility.cls';
  // jorje already offers CheckLedgerEligibility from its workspace index.
  assert.deepEqual(labels(own), RESP);
  assert.deepEqual(labels('file:///c%3A/force-app/main/default/classes/checkledgereligibility.cls'), RESP);
  assert.equal(labels(own, 'Che§'), undefined); // typing "Che": one item (jorje's), not two
  // Untitled buffers have no language server behind them: keep it.
  assert.deepEqual(labels('untitled:Untitled-1'), ALL_THREE);
  assert.deepEqual(labels('untitled:Untitled-1', 'Che§'), ['CheckLedgerEligibility']);
  // File name and class name differ (class renamed, not saved yet): keep it.
  assert.deepEqual(labels('file:///c%3A/force-app/main/default/classes/Renamed.cls'), ALL_THREE);
});

test('extension returns undefined when nothing can match the typed word (word-based fallback stays)', () => {
  const { registered, settings, configCalls } = loadExtension();
  const provider = registered[0].provider;
  const src = 'public class Foo {\n    void m() {\n        Integer accountCount = 1;\n        acc§\n    }\n}\n';
  const acc = fakeDocument(src, 1, 'untitled:Untitled-1');
  assert.equal(provider.provideCompletionItems(acc.doc, acc.position, {}), undefined);
  const fo = fakeDocument(src.replace('acc§', 'Fo§'), 2, 'untitled:Untitled-1');
  assert.deepEqual(provider.provideCompletionItems(fo.doc, fo.position, {}).map((i) => i.label), ['Foo']);
  // The setting is read for the document (language overrides apply).
  const last = configCalls[configCalls.length - 1];
  assert.equal(last.section, 'editor.suggest');
  assert.equal(last.scope, fo.doc);
  // "o" is inside "Foo", not at a word start: hidden by default ...
  const o = fakeDocument(src.replace('acc§', 'o§'), 3, 'untitled:Untitled-1');
  assert.equal(provider.provideCompletionItems(o.doc, o.position, {}), undefined);
  // ... but offered once editor.suggest.matchOnWordStartOnly is off.
  settings['editor.suggest.matchOnWordStartOnly'] = false;
  assert.deepEqual(provider.provideCompletionItems(o.doc, o.position, {}).map((i) => i.label), ['Foo']);
  // A configuration read that throws falls back to the default.
  settings.throwOnRead = true;
  assert.deepEqual(provider.provideCompletionItems(fo.doc, fo.position, {}).map((i) => i.label), ['Foo']);
  assert.equal(provider.provideCompletionItems(o.doc, o.position, {}), undefined);
});

test('extension never throws', () => {
  const { registered, listeners, ext } = loadExtension();
  const provider = registered[0].provider;
  const broken = { uri: { toString: () => 'file:///broken.cls' }, version: 1, getText() { throw new Error('boom'); } };
  assert.equal(provider.provideCompletionItems(broken, { line: 0, character: 0 }, {}), undefined);
  const { doc } = fakeDocument(inMethod('Resp§'), 7, 'file:///other.cls');
  doc.offsetAt = () => { throw new Error('boom'); };
  assert.equal(provider.provideCompletionItems(doc, { line: 0, character: 0 }, {}), undefined);
  assert.equal(provider.provideCompletionItems(null, null, null), undefined);
  listeners[0](null);
  ext.activate(null);
  ext.deactivate();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('extension publishes the crash diagnostic after a pause and clears it on fix and close', async () => {
  const { ext, fake, opened, changed, listeners, diagnostics } = loadExtension();
  const uri = 'file:///c%3A/force-app/main/default/classes/LedgerEligibility.cls';
  const v1 = fakeDocument(LOGGED, 1, uri);
  opened[0](v1.doc);
  assert.equal(diagnostics.get(v1.doc.uri), undefined, 'computed on a timer, not inside the event');
  await sleep(30);
  const [d] = diagnostics.get(v1.doc.uri);
  assert.equal(d.severity, fake.DiagnosticSeverity.Error);
  assert.equal(d.source, 'virga');
  assert.equal(d.code, 'jorje-crash');
  assert.equal(d.message, `Raw List in an @InvocableMethod parameter. ${CONSEQUENCE} Use List<Type>.`);
  assert.deepEqual([d.range.start, d.range.end], [{ line: 2, character: 46 }, { line: 2, character: 50 }]);

  // Typing the fix: nothing changes until the pause, then the list is empty.
  const v2 = fakeDocument(LOGGED.replace('(List)', '(List<Request> requests)'), 2, uri);
  changed[0]({ document: v2.doc, contentChanges: [] });
  await sleep(30);
  assert.equal(diagnostics.get(v2.doc.uri).length, 1, 'still the last result while typing');
  await sleep(ext.DEBOUNCE_MS + 60);
  assert.deepEqual(diagnostics.get(v2.doc.uri), []);

  // Several quick edits: one refresh, on the last text.
  const v3 = fakeDocument(LOGGED.replace('(List)', '(List<R)'), 3, uri);
  const v4 = fakeDocument(LOGGED.replace('(List)', '(List<Request)'), 4, uri);
  changed[0]({ document: v3.doc });
  changed[0]({ document: v4.doc });
  await sleep(ext.DEBOUNCE_MS + 60);
  assert.equal(v3.doc.getTextCalls, 0, 'superseded version never scanned');
  assert.equal(diagnostics.get(v4.doc.uri)[0].message.split('.')[0], 'Unclosed List<Request in an @InvocableMethod parameter');

  // Closing drops the diagnostics and any pending refresh.
  changed[0]({ document: v1.doc });
  listeners[0](v1.doc);
  await sleep(ext.DEBOUNCE_MS + 60);
  assert.equal(diagnostics.get(v1.doc.uri), undefined);
});

test('extension checks Apex files open at activation, never apex-anon or other languages', async () => {
  const cls = fakeDocument(LOGGED, 1, 'file:///c%3A/x/LedgerEligibility.cls');
  const untitled = fakeDocument(LOGGED, 1, 'untitled:Untitled-1');
  const anon = fakeDocument(LOGGED, 1, 'file:///c%3A/x/scripts/apex/hello.apex', 'apex-anon');
  const text = fakeDocument(LOGGED, 1, 'file:///c%3A/x/notes.txt', 'plaintext');
  const git = fakeDocument(LOGGED, 1, 'git:/c%3A/x/LedgerEligibility.cls');
  const { diagnostics, opened, ext } = loadExtension([cls.doc, untitled.doc, anon.doc, text.doc, git.doc]);
  await sleep(30);
  assert.equal(diagnostics.get(cls.doc.uri).length, 1);
  assert.equal(diagnostics.get(untitled.doc.uri).length, 1);
  for (const other of [anon, text, git]) {
    opened[0](other.doc);
    ext.refresh(other.doc);
  }
  await sleep(30);
  for (const other of [anon, text, git]) {
    assert.equal(diagnostics.get(other.doc.uri), undefined, other.doc.uri.toString());
    assert.equal(other.doc.getTextCalls, 0);
  }
});

test('extension leaves the generated Salesforce stubs under .sfdx/ alone', async () => {
  // StandardApexLibrary stubs (read-only, generated by the Salesforce CLI)
  // have raw collections in global signatures: nothing there to fix.
  const stub = [
    'global class Database {',
    '  global static Database.Cursor getCursorWithBinds(String query, Map bindMap, Object accessLevel) {}',
    '  global static Object beginInvoke(Object stub, Object request, List info) {}',
    '}',
    '',
  ].join('\n');
  assert.equal(breakers(stub).length, 2, 'the shapes themselves are flagged elsewhere');
  const uris = [
    'file:///c%3A/work/my-project/.sfdx/tools/262/StandardApexLibrary/System/Database.cls',
    'file:///home/me/project/.SFDX/tools/262/StandardApexLibrary/System/Database.cls',
  ];
  const docs = uris.map((uri) => fakeDocument(stub, 1, uri));
  const { diagnostics, opened, changed, ext, codeActionProviders } = loadExtension(docs.map((d) => d.doc));
  for (const { doc } of docs) {
    opened[0](doc);
    changed[0]({ document: doc });
    ext.refresh(doc);
  }
  await sleep(ext.DEBOUNCE_MS + 60);
  for (const { doc } of docs) {
    assert.equal(diagnostics.get(doc.uri), undefined, doc.uri.toString());
    assert.equal(doc.getTextCalls, 0, doc.uri.toString());
    const fake = { source: 'virga', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } };
    assert.equal(codeActionProviders[0].provider.provideCodeActions(doc, fake.range, { diagnostics: [fake] }), undefined);
  }
  // The same text in a project class is checked as usual, and so is a folder
  // whose name only contains "sfdx".
  for (const uri of ['file:///c%3A/x/force-app/main/default/classes/Database.cls', 'file:///c%3A/x/my.sfdx-tools/classes/Database.cls']) {
    const own = fakeDocument(stub, 1, uri);
    ext.refresh(own.doc);
    assert.equal(diagnostics.get(own.doc.uri).length, 2, uri);
  }
});

test('extension offers the fixes as QuickFix code actions, preferred only when unambiguous', () => {
  const { ext, codeActionProviders, diagnostics } = loadExtension();
  const provider = codeActionProviders[0].provider;
  const { doc } = fakeDocument(LOGGED, 1);
  ext.refresh(doc);
  const [d] = diagnostics.get(doc.uri);
  const out = provider.provideCodeActions(doc, d.range, { diagnostics: [d] });
  assert.equal(out.length, 1);
  const [action] = out;
  assert.equal(action.title, 'Change to List<Request> requests');
  assert.equal(action.kind, 'quickfix');
  assert.equal(action.isPreferred, true);
  assert.deepEqual(action.diagnostics, [d]);
  assert.equal(action.edit.replacements.length, 1);
  const [rep] = action.edit.replacements;
  assert.equal(rep.uri, doc.uri);
  assert.equal(rep.newText, 'List<Request> requests');
  assert.equal(LOGGED.slice(doc.offsetAt(rep.range.start), doc.offsetAt(rep.range.end)), 'List');

  // Two equally good input classes: both offered, neither preferred. The
  // parameter had no name, so each fix names it after its own class.
  const two = fakeDocument(LOGGED.replace('public class Response {', 'public class Input { @InvocableVariable public String id; }\n    public class Response {'), 2);
  ext.refresh(two.doc);
  const [d2] = diagnostics.get(two.doc.uri);
  const both = provider.provideCodeActions(two.doc, d2.range, { diagnostics: [d2] });
  assert.deepEqual(both.map((a) => [a.title, a.isPreferred]), [
    ['Change to List<Request> requests', false],
    ['Change to List<Input> inputs', false],
  ]);

  // Diagnostics of other sources (the language server's own) get nothing.
  const jorje = { range: d.range, message: "Expecting '<' but was: ')'", source: 'apex' };
  assert.equal(provider.provideCodeActions(doc, d.range, { diagnostics: [jorje] }), undefined);
  assert.equal(provider.provideCodeActions(doc, d.range, { diagnostics: [] }), undefined);
  // A stale diagnostic whose shape is gone from the text gets nothing either.
  const fixed = fakeDocument(LOGGED.replace('(List)', '(List<Request> requests)'), 3);
  assert.equal(provider.provideCodeActions(fixed.doc, d.range, { diagnostics: [d] }), undefined);
});

test('extension crash check never throws', () => {
  const { ext, opened, changed, listeners, codeActionProviders } = loadExtension();
  const provider = codeActionProviders[0].provider;
  assert.equal(provider.provideCodeActions(null, null, null), undefined);
  const broken = { uri: fakeUri('file:///c%3A/broken.cls'), languageId: 'apex', version: 1, getText() { throw new Error('boom'); } };
  assert.equal(provider.provideCodeActions(broken, null, { diagnostics: [{ source: 'virga', range: { start: { line: 0, character: 0 } } }] }), undefined);
  ext.refresh(broken);
  ext.refresh(null);
  opened[0](null);
  changed[0](null);
  changed[0]({});
  listeners[0](undefined);
  ext.deactivate();
  ext.refresh(fakeDocument(LOGGED, 9).doc); // after deactivate: no collection, no throw
});

// ---------------------------------------------------------------- runner

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      const note = await fn();
      console.log(`ok   ${name}${note ? `  (${note})` : ''}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${name}`);
      console.log(String(err && err.stack ? err.stack : err).replace(/^/gm, '     '));
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
