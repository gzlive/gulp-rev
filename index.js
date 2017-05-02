'use strict';
var path = require('path');
var gutil = require('gulp-util');
var through = require('through2');
var objectAssign = require('object-assign');
var file = require('vinyl-file');
var revHash = require('rev-hash');
var revPath = require('rev-path');
var sortKeys = require('sort-keys');
var modifyFilename = require('modify-filename');

function relPath(base, filePath) {
    if (filePath.indexOf(base) !== 0) {
        return filePath.replace(/\\/g, '/');
    }

    var newPath = filePath.substr(base.length).replace(/\\/g, '/');

    if (newPath[0] === '/') {
        return newPath.substr(1);
    }

    return newPath;
}

function getManifestFile(opts, cb) {
    file.read(opts.path, opts, function (err, manifest) {
        if (err) {
            // not found
            if (err.code === 'ENOENT') {
                cb(null, new gutil.File(opts));
            } else {
                cb(err);
            }

            return;
        }

        cb(null, manifest);
    });
}

function transformFilename(file, opts) {
    // save the old path for later
    file.revOrigPath = file.path;
    file.revOrigBase = file.base;
    file.revHash = revHash(file.contents);

    file.path = modifyFilename(file.path, function (filename, extension) {
        var extIndex = filename.indexOf('.');

        if (opts.hashInQuery) {
            filename = extIndex === -1 ?
                revPath.revert(revPath(filename, file.revHash), file.revHash) :
                revPath.revert(revPath(filename.slice(0, extIndex), file.revHash), file.revHash) + filename.slice(extIndex);
        } else {
            filename = extIndex === -1 ?
                revPath(filename, file.revHash) :
                revPath(filename.slice(0, extIndex), file.revHash) + filename.slice(extIndex);
        }
        return filename + extension;
    });
}

var plugin = function (opts) {
    var sourcemaps = [];
    var pathMap = {};

    opts = objectAssign({
        hashInQuery: false
    }, opts);

    return through.obj(function (file, enc, cb) {
        if (file.isNull()) {
            cb(null, file);
            return;
        }

        if (file.isStream()) {
            cb(new gutil.PluginError('gulp-rev', 'Streaming not supported'));
            return;
        }

        // this is a sourcemap, hold until the end
        if (path.extname(file.path) === '.map') {
            sourcemaps.push(file);
            cb();
            return;
        }

        var oldPath = file.path;
        transformFilename(file, opts);
        pathMap[oldPath] = file.revHash;

        cb(null, file);
    }, function (cb) {
        sourcemaps.forEach(function (file) {
            var reverseFilename;

            // attempt to parse the sourcemap's JSON to get the reverse filename
            try {
                reverseFilename = JSON.parse(file.contents.toString()).file;
            } catch (err) { }

            if (!reverseFilename) {
                reverseFilename = path.relative(path.dirname(file.path), path.basename(file.path, '.map'));
            }

            if (pathMap[reverseFilename]) {
                // save the old path for later
                file.revOrigPath = file.path;
                file.revOrigBase = file.base;

                var hash = pathMap[reverseFilename];
                file.path = revPath.revert(revPath(file.path.replace(/\.map$/, ''), hash), hash) + '.map';
            } else {
                transformFilename(file, opts);
            }

            this.push(file);
        }, this);

        cb();
    });
};

plugin.manifest = function (pth, opts) {
    if (typeof pth === 'string') {
        pth = { path: pth };
    }

    opts = objectAssign({
        path: 'rev-manifest.json',
        merge: false,
        // Apply the default JSON transformer.
        // The user can pass in his on transformer if he wants. The only requirement is that it should
        // support 'parse' and 'stringify' methods.
        transformer: JSON,
        hashInQuery: false
    }, opts, pth);

    var manifest = {};

    return through.obj(function (file, enc, cb) {
        // ignore all non-rev'd files
        if (!file.path || !file.revOrigPath) {
            cb();
            return;
        }

        var revisionedFile = relPath(file.base, file.path);
        var originalFile = path.join(path.dirname(revisionedFile), path.basename(file.revOrigPath)).replace(/\\/g, '/');

        manifest[originalFile] = opts.hashInQuery ? originalFile + '?v=' + file.revHash : revisionedFile;

        cb();
    }, function (cb) {
        // no need to write a manifest file if there's nothing to manifest
        if (Object.keys(manifest).length === 0) {
            cb();
            return;
        }

        getManifestFile(opts, function (err, manifestFile) {
            if (err) {
                cb(err);
                return;
            }

            if (opts.merge && !manifestFile.isNull()) {
                var oldManifest = {};

                try {
                    oldManifest = opts.transformer.parse(manifestFile.contents.toString());
                } catch (err) { }

                manifest = objectAssign(oldManifest, manifest);
            }

            manifestFile.contents = new Buffer(opts.transformer.stringify(sortKeys(manifest), null, '  '));
            this.push(manifestFile);
            cb();
        }.bind(this));
    });
};

module.exports = plugin;
