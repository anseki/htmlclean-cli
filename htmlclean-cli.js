#!/usr/bin/env node

/*
 * readlineSync - Command Line Tool
 * https://github.com/anseki/readline-sync
 *
 * Copyright (c) 2017 anseki
 * Licensed under the MIT license.
 */

'use strict';

var
  htmlclean = require('htmlclean'),
  program = require('commander'),
  fs = require('fs'),
  glob = require('glob'),
  pathUtil = require('path'),

  packageInfo = require('./package'),
  options = {protect: [], unprotect: []},
  count = 0,
  // cache input contents and output fd etc.
  inContents = {},
  outFiles = {'-': {fd: process.stdout.fd, path: 'STDOUT'}},
  DEFAULT_BUF_SIZE = 1024;

// mkdir -p
function mkdirParents(dirPath) {
  dirPath.split(/\/|\\/).reduce(function(parents, dir) {
    var path = pathUtil.resolve((parents += dir + pathUtil.sep)); // normalize
    if (!fs.existsSync(path)) {
      fs.mkdirSync(path);
    } else if (!fs.statSync(path).isDirectory()) {
      throw new Error('Non directory already exists: ' + path);
    }
    return parents;
  }, '');
}

function addList(val, list) {
  list.push(val);
  return list;
}

function printInfo() {
  if (program.verbose) {
    console.warn.apply(console, arguments);
  }
}

function getInContent(path) { // path was normalized

  function readStdin() {
    var stdin = process.stdin,
      fd = stdin.isTTY && process.platform !== 'win32' ?
        fs.openSync('/dev/tty', 'rs') : stdin.fd,
      bufSize = stdin.isTTY ? DEFAULT_BUF_SIZE :
        (fs.fstatSync(fd).size || DEFAULT_BUF_SIZE),
      buffer = Buffer.allocUnsafe && Buffer.alloc ? Buffer.alloc(bufSize) : new Buffer(bufSize),
      rsize, input = '';
    while (true) {
      rsize = 0;
      try {
        rsize = fs.readSync(fd, buffer, 0, bufSize);
      } catch (e) {
        if (e.code === 'EOF') { break; }
        throw e;
      }
      if (rsize === 0) { break; }
      input += buffer.toString(program.encoding, 0, rsize);
    }
    return input;
  }

  if (!inContents[path]) {
    if (path === '-') {
      inContents[path] = {content: htmlclean(readStdin(), options), path: 'STDIN'};
    } else {
      inContents[path] = {
        content: htmlclean(fs.readFileSync(path, {encoding: program.encoding}),
          options),
        path: path};
    }
  }
  return inContents[path];
}

function getOutFile(path, inPath, root) {
  var normalPath, key, fd;

  function getMinPath(path) {
    var suffix = pathUtil.extname(path);
    return pathUtil.join(pathUtil.dirname(path),
      pathUtil.basename(path, suffix) + '.min' + suffix);
  }

  function getPathInDir(path, dirPath) {
    var pathInDir, dirPathInDir;
    // root and path (inPath) are already normal. (separators are correct)
    if (typeof root === 'string' && root.substr(-1) !== pathUtil.sep) {
      root += pathUtil.sep;
    }
    if (typeof root === 'string' &&
        (process.platform === 'win32' ? path.toLowerCase().indexOf(root.toLowerCase()) :
          path.indexOf(root)) === 0) {
      pathInDir = pathUtil.join(dirPath, path.substr(root.length));
      dirPathInDir = pathUtil.dirname(pathInDir);
      mkdirParents(dirPathInDir);
      return pathInDir;
    } else {
      return pathUtil.join(dirPath, pathUtil.basename(path));
    }
  }

  if (typeof path !== 'string' || path === '') { // inPath must be given, if path isn't
    path = inPath === '-' ? '-' : getMinPath(inPath);
  }
  if (path === '-') {
    key = path;
  } else {
    normalPath = key = pathUtil.resolve(path);
    if (process.platform === 'win32') { key = key.toLowerCase(); }
  }

  if (!outFiles[key]) {
    try {
      fd = fs.openSync(normalPath, 'w');
    } catch (e) {
      if (e.code === 'EISDIR' && typeof inPath === 'string') { // path is directory
        return getOutFile(inPath === '-' ? '-' : getPathInDir(inPath, normalPath));
      } else {
        // file in directory that doesn't exist,
        // re-parsed path is directory, or others
        throw e;
      }
    }
    outFiles[key] = {fd: fd, path: fs.realpathSync(normalPath)};
  }
  return outFiles[key];
}

function pair(input, output, root, recursive) {
  var paths, inContent, outFile;

  // normalize input
  if (typeof input !== 'string' || input === '') {
    input = '-';
  } else if (input !== '-') { // path or pattern
    paths = glob.sync(input);
    if (!paths.length) { // Not found
      return;
    } else if (paths.length > 1) {
      paths.forEach(function(path) {
        pair(path.replace(/\\/g, '/'), output, root, true);
      });
      return;
    } else if (fs.statSync(paths[0]).isDirectory()) {
      if (!recursive && typeof root !== 'string') {
        root = fs.realpathSync(paths[0]); // set default
      }
      paths[0] = paths[0].replace(/\\/g, '/');
      pair(paths[0] + (paths[0].substr(-1) !== '/' ? '/' : '') + '**/*.html',
        output, root, true);
      return;
    } else if (!fs.statSync(paths[0]).isFile()) {
      throw new Error('Non file or directory: ' + paths[0]);
    }
    input = fs.realpathSync(paths[0]);
  }
  // get content from input
  inContent = getInContent(input);

  // normalize & open output
  outFile = getOutFile(output, input, root);

  fs.writeSync(outFile.fd, inContent.content, null, program.encoding);
  // fsyncSync gets an error (bad file descriptor) when STDOUT is TTY of csh or DOS.
  try {
    fs.fsyncSync(outFile.fd);
  } catch (e) { /* ignore */ }

  printInfo('[%d] Done\n  INPUT : %s\n  OUTPUT: %s',
    ++count, inContent.path, outFile.path);
}

program
  .version(packageInfo.version)
  .description((function(text) {
    var lines = [], line = '';
    text.split(' ').forEach(function(word) {
      if (line.length + 1 + word.length > 77) { // MAX: 79
        lines.push(line);
        line = word;
      } else {
        line += (line ? ' ' : '') + word;
      }
    });
    if (line !== '') { lines.push(line); }
    return lines.join('\n  ');
  })(packageInfo.description) + '\n  ' + packageInfo.homepage)
  .usage('[options] [input1 [input2 ...]]')
  .option('-i, --input <input>', 'input file, directory or "-" as STDIN', addList, [])
  .option('-o, --output <output>', 'output file, directory or "-" as STDOUT', addList, [])
  .option('-r, --root <directory>', 'root of directory tree')
  .option('-p, --protect <RegExp>', '"/pattern/flags" for protect', addList, [])
  .option('-P, --unprotect <RegExp>', '"/pattern/flags" for unprotect', addList, [])
  .option('-e, --encoding <encoding>', 'encoding method [utf8]', 'utf8')
  .option('-v, --verbose', 'output I/O information to STDERR')
  .on('--help', function() {
    console.log(fs.readFileSync(pathUtil.join(__dirname, 'help.txt'), {encoding: 'utf8'}) +
      (process.platform !== 'win32' ? '\n' : ''));
  });
program.parse(process.argv);

if (program.args.length) {
  program.input = program.input.concat(program.args);
} else if (!program.input.length) {
  program.input.push('-');
}

// protect/unprotect
(function() {
  var reRe = /^\s*\/(.+)\/\s*(\w*)\s*$/;
  ['protect', 'unprotect'].forEach(function(prop) {
    program[prop].forEach(function(re) {
      var matches = reRe.exec(re);
      if (!matches) {
        console.error('SyntaxError: Invalid regular expression: %s', re);
        process.exit(1);
      }
      try {
        options[prop].push(new RegExp(matches[1], matches[2]));
      } catch (e) {
        console.error(e + '');
        process.exit(1);
      }
    });
  });
})();

if (program.root != null) {
  if (fs.existsSync(program.root) && fs.statSync(program.root).isDirectory()) {
    program.root = fs.realpathSync(program.root);
  } else {
    console.error('This is not directory: %s', program.root);
    process.exit(1);
  }
}

// I/O loop
program.input.forEach(function(input, index) {
  var output = program.output[index];
  printInfo('[ARGUMENT]\n  INPUT : %s\n  OUTPUT: %s', input || '', output || '');
  try {
    pair(input, output, program.root);
  } catch (e) {
    console.error(e + '');
  }
});

// finalize
(function() {
  var key;
  for (key in outFiles) {
    if (key !== '-' && outFiles.hasOwnProperty(key)) {
      try {
        fs.closeSync(outFiles[key].fd);
      } catch (e) { /* ignore */ }
    }
  }
})();

process.exit();
