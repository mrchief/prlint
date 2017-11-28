const flatten = require('flat');
const fs = require('fs');
const got = require('got');
const jsonwebtoken = require('jsonwebtoken');
const { json, send } = require('micro');

function newJsonWebToken() {
  // https://developer.github.com/apps/building-integrations/setting-up-and-registering-github-apps/about-authentication-options-for-github-apps/#authenticating-as-a-github-app
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (10 * 60),
    iss: 7012 // https://github.com/settings/apps/prlint
  }

  let privateKeyBuffer = new Buffer(process.env.PRIVATE_KEY_B64, 'base64');
  let privateKey = privateKeyBuffer.toString('ascii');
  return jsonwebtoken.sign(payload, privateKey, { algorithm: 'RS256'});
}

async function updateShaStatus(body, res) {
  const pull_request_flat = flatten(body.pull_request);
  const accessToken = accessTokens[`${body.installation.id}`].token;

  try {
    const configUrl = `https://api.github.com/repos/${body.repository.full_name}/contents/.github/prlint.json?ref=${body.pull_request.head.ref}`
    const config = await got(configUrl, {
      headers: {
        Accept: "application/vnd.github.machine-man-preview+json",
        Authorization: `token ${accessToken}`
      }
    });

    const userConfigBase64 = JSON.parse(config.body).content
    const userConfig = JSON.parse(Buffer.from(userConfigBase64, 'base64'));

    let failureMessages = [];
    Object.keys(userConfig).map(element => {
      userConfig[element].forEach((item, index) => {
        const pattern = item.pattern;
        const regex = new RegExp(pattern, item.flags || '');
        pass = regex.test(pull_request_flat[element])
        if (!pass) {
          failureMessages.push(`\`/${item.pattern}/.test('${pull_request_flat[element]}')\` failed`);
        }
      })
    })

    let bodyPayload = {};
    if (!failureMessages.length) {
      bodyPayload = {
        state: 'success',
        description: 'Your validation rules passed',
        context: 'PRLint'
      };
    } else {
      bodyPayload = {
        state: 'failure',
        description: failureMessages[0],
        target_url: `https://github.com/${body.repository.full_name}/blob/${body.pull_request.head.sha}/.github/prlint.json`,
        context: 'PRLint'
      }
    }

    try {
      const statusUrl = `https://api.github.com/repos/${body.repository.full_name}/statuses/${body.pull_request.head.sha}`
      const status = await got.post(statusUrl, {
        headers: {
          Accept: "application/vnd.github.machine-man-preview+json",
          Authorization: `token ${accessToken}`
        },
        body: bodyPayload,
        json: true
      });
      send(res, 200, bodyPayload);
    } catch (exception) {
      send(res, 500, exception);
    }
  } catch (exception) {
    let description = exception.toString();
    if (exception.response.statusCode === 404) {
      description = '`.github/prlint.json` not found'
    }
    const statusUrl = `https://api.github.com/repos/${body.repository.full_name}/statuses/${body.pull_request.head.sha}`
    const status = await got.post(statusUrl, {
      headers: {
        Accept: "application/vnd.github.machine-man-preview+json",
        Authorization: `token ${accessToken}`
      },
      body: {
        state: 'error',
        description: description,
        context: 'PRLint',
        target_url: 'https://github.com/ewolfe/prlint#support'
      },
      json: true
    });
    send(res, 500, exception);
  }
}

// INITIALIZE APP VARIABLES
const accessTokens = {};
let JWT = newJsonWebToken();

module.exports = async (req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(200, {'Content-Type': 'image/x-icon'} );
    res.end();
  }

  if (req.url === '/') {
    send(res, 200, accessTokens);
  }

  if (req.url === '/webhook' && req.method === 'POST') {
    const body = await json(req);
    console.log(body)

    if (body && body.pull_request && body.installation && body.installation.id && accessTokens[`${body.installation.id}`]) {
      await updateShaStatus(body, res);
    } else if (body && body.pull_request && body.installation && body.installation.id && !accessTokens[`${body.installation.id}`]) {
      try {
        const response = await got.post(`https://api.github.com/installations/${body.installation.id}/access_tokens`, {
          headers: {
            Accept: "application/vnd.github.machine-man-preview+json",
            Authorization: `Bearer ${JWT}`
          }
        });
        accessTokens[`${body.installation.id}`] = JSON.parse(response.body);
        await updateShaStatus(body, res);
      } catch (exception) {
        send(res, 500, exception);
      }
    } else if (body && !body.pull_request) {
      send(res, 200, body);
    } else {
      send(res, 400, `invalid request payload`);
    }
  }
}
