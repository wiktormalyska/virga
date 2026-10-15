'use strict';

// Test only (Windows, through sf.cmd): stands in for the Salesforce CLI while the README screenshots are
// taken (run-e2e.mjs with ONLY_SHOTS=1 puts this folder first on PATH). Answers
// `sf apex run` and `sf data query` with recorded-style JSON for the scripts in
// ../index.js, so the screenshots never need an org. Record ids are synthetic.

const fs = require('fs');

const args = process.argv.slice(2);
const command = args.slice(0, 2).join(' ');
const file = args[args.indexOf('--file') + 1];
const source = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

function apexRun() {
  const t = (n) => `12:00:00.${String(n).padStart(2, '0')} (${4000000 + n * 1000})`;
  const debug = (n, line, level, msg) => `${t(n)}|USER_DEBUG|[${line}]|${level}|${msg}`;
  const lines = [
    '68.0 APEX_CODE,DEBUG;APEX_PROFILING,INFO',
    ...source.split('\n').map((l) => `Execute Anonymous: ${l}`),
    `${t(1)}|USER_INFO|[EXTERNAL]|005000000000001|user@example.com|(GMT+00:00) Coordinated Universal Time (UTC)|GMT+00:00`,
    `${t(2)}|EXECUTION_STARTED`,
    `${t(3)}|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex`,
    debug(10, 7, 'DEBUG', '3 accounts with an industry'),
    debug(11, 9, 'INFO', 'Account:{Id=001Dm0000AbC101AAA, Name=Burlington Textiles Corp of America, Industry=Apparel}'),
    debug(12, 9, 'INFO', 'Account:{Id=001Dm0000AbC102AAA, Name=Dickenson plc, Industry=Consulting}'),
    debug(13, 9, 'INFO', 'Account:{Id=001Dm0000AbC103AAA, Name=Edge Communications, Industry=Electronics}'),
    debug(14, 11, 'WARN', '1 of 100 queries used'),
    `${t(20)}|CUMULATIVE_LIMIT_USAGE`,
    `${t(20)}|LIMIT_USAGE_FOR_NS|(default)|`,
    '  Number of SOQL queries: 1 out of 100',
    '  Number of query rows: 3 out of 50000',
    '  Number of SOSL queries: 0 out of 20',
    '  Number of DML statements: 0 out of 150',
    '  Number of Publish Immediate DML: 0 out of 150',
    '  Number of DML rows: 0 out of 10000',
    '  Maximum CPU time: 14 out of 10000',
    '  Maximum heap size: 0 out of 10000000',
    '  Number of callouts: 0 out of 100',
    '  Number of Email Invocations: 0 out of 10',
    '  Number of future calls: 0 out of 50',
    '  Number of queueable jobs added to the queue: 0 out of 50',
    '  Number of Mobile Apex push calls: 0 out of 10',
    '',
    `${t(20)}|CUMULATIVE_LIMIT_USAGE_END`,
    '',
    `${t(21)}|CODE_UNIT_FINISHED|execute_anonymous_apex`,
    `${t(22)}|EXECUTION_FINISHED`,
    '',
  ];
  return {
    status: 0,
    result: {
      success: true,
      compiled: true,
      compileProblem: '',
      exceptionMessage: '',
      exceptionStackTrace: '',
      line: -1,
      column: -1,
      logs: lines.join('\n'),
    },
    warnings: [],
  };
}

function dataQuery() {
  const account = (n, name, industry) => ({
    attributes: { type: 'Account', url: `/services/data/v64.0/sobjects/Account/001Dm0000AbC10${n}AAA` },
    Id: `001Dm0000AbC10${n}AAA`,
    Name: name,
    Industry: industry,
  });
  return {
    status: 0,
    result: {
      records: [
        account(1, 'Burlington Textiles Corp of America', 'Apparel'),
        account(2, 'Dickenson plc', 'Consulting'),
        account(3, 'Edge Communications', 'Electronics'),
      ],
      totalSize: 3,
      done: true,
    },
    warnings: [],
  };
}

const answer = command === 'apex run' ? apexRun()
  : command === 'data query' ? dataQuery()
    : { status: 1, name: 'FakeSfError', message: `the screenshot sf does not know "${command}"`, exitCode: 1 };
// A real run takes a moment; so does this one, so the header shows a plausible time.
setTimeout(() => {
  process.stdout.write(JSON.stringify(answer, null, 2));
  process.exitCode = answer.status;
}, 700);
