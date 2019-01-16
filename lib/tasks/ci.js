/* eslint-disable promise/prefer-await-to-then */
/* eslint-disable promise/prefer-await-to-callbacks */

const fs = require('fs');
const path = require('path');
const log = require('fancy-log');
const findRoot = require('find-root');
const requestPromise = require('request-promise');
const request = require('request');
const B = require('bluebird');
const os = require('os');
const octokit = require('@octokit/rest')();
const _ = require('lodash');


const readFile = B.promisify(fs.readFile, {context: fs});
const writeFile = B.promisify(fs.writeFile, {context: fs});

const ASSET_NAME_REGEXP = /^appium-\S+.zip$/;

const GITHUB_OWNER = 'appium';
const GITHUB_REPO = 'appium-build-store';

const OUTPUT_INTERVAL = 60000;

const configure = function configure (gulp, opts) {
  /**
   * `mocha-parallel-tests` is broken at the moment, so skipped describe blocks fail
   * the fix is simple, and this patches the error until they fix the package
   **/
  gulp.task('fix-mocha-parallel-tests', function () {
    const root = opts.projectRoot ? opts.projectRoot : findRoot(__dirname);
    const filePath = path.resolve(root, 'node_modules', 'mocha-parallel-tests', 'dist', 'main', 'util.js');

    return readFile(filePath, {encoding: 'utf8'})
      .then(function (script) {
        return script.replace(`if (value.type === 'test') {`, `if (value.type === 'test') {\n        delete value.fn;`);
      })
      .then(function (script) {
        return writeFile(filePath, script);
      })
      .catch(function (err) {
        log.error(`Unable to fix 'mocha-parallel-tests': ${err.message}`);
        throw err;
      });
  });


  gulp.task('github-authenticate', function (done) {
    const githubToken = process.env.GITHUB_TOKEN;

    if (_.isEmpty(githubToken)) {
      log.warn('No GitHub token found in GITHUB_TOKEN environment variable');
      return;
    }

    octokit.authenticate({
      type: 'token',
      token: githubToken,
    });
    done();
  });

  gulp.task('github-download', function () {
    log.info('Downloading GitHub asset');
    const tempDir = os.tmpdir();
    log.info(`Temporary directory for download: '${tempDir}'`);

    const owner = opts.ci.owner || GITHUB_OWNER;
    const repo = opts.ci.repo || GITHUB_REPO;
    log.info(`Downloading repository: '${owner}/${repo}'`);
    return octokit.repos.getLatestRelease({owner, repo})
      .then(function (res) {
        // go through the assets and fine the correct one
        for (const asset of res.data.assets) {
          if (ASSET_NAME_REGEXP.test(asset.name)) {
            log.info(`Downloading asset from '${asset.browser_download_url}'`);
            return asset.browser_download_url;
          }
        }
        throw new Error(`Unable to find Appium build asset`);
      })
      .then(function download (url) {
        return new B((resolve, reject) => {
          request(url)
            .on('error', reject) // handle real errors, like connection errors
            .on('response', function (res) {
              // handle responses that fail, like 404s
              if (res.statusCode >= 400) {
                return reject(`Error downloading file: ${res.statusCode}`);
              }
            })
            .pipe(fs.createWriteStream(`${tempDir}/appium.zip`))
            .on('close', resolve);
        });
      });
  });

  gulp.task('saucelabs-upload', function () {
    // Find the latest bundle
    log.info('Uploading to Sauce Storage');
    const tempDir = os.tmpdir();
    log.info(`Temporary directory for upload: '${tempDir}'`);
    const options = {
      method: 'POST',
      uri: `https://saucelabs.com/rest/v1/storage/${process.env.SAUCE_USERNAME}/appium.zip?overwrite=true`,
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      auth: {
        user: process.env.SAUCE_USERNAME,
        pass: process.env.SAUCE_ACCESS_KEY,
      },
      formData: {
        file: {
          value: fs.createReadStream(`${tempDir}/appium.zip`),
          options: {
            filename: 'appium.zip',
            contentType: 'application/zip, application/octet-stream',
          },
        }
      },
      json: true,
    };
    return requestPromise(options)
      .then(function (body) {
        // username should not end up in the logs
        body.username = '*'.repeat((body.username || '').length);
        log.info(`File uploaded: ${JSON.stringify(body)}`);
      });
  });

  gulp.task('sauce-storage-upload', gulp.series(['github-authenticate', 'github-download', 'saucelabs-upload']));


  /**
   * This task is meant to be backgrounded, and killed using OS tools, so it
   * never finishes.
   *   $ $(npm bin)/gulp periodic-output &
   *   [1] 38060
   *   [08:56:53] Using gulpfile ~/code/appium-xcuitest-driver/gulpfile.js
   *   [08:56:53] Starting 'periodic-output'...
   *   $ kill 38060
   *   [1]  + 38060 terminated  $(npm bin)/gulp periodic-output
   */
  gulp.task('periodic-output', function () {
    const interval = opts.ci.interval || OUTPUT_INTERVAL;
    return new B(function () {
      setInterval(function print () {
        process.stdout.write('.');
      }, interval);
    });
  });
};

module.exports = {
  configure,
};