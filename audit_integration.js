
const { CredentialManager } = require('./utils/credential-manager');
const { Database } = require('./database/db');
const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');

async function audit() {
  console.log('\x1b[36m%s\x1b[0m', '--- Real-World Integration Audit (Client-Side Token Flow) ---');
  
  const token = process.argv[2];
  if (!token) {
    console.log('\x1b[33m%s\x1b[0m', '⚠️  No access token provided via CLI.');
    console.log('Usage: node audit_integration.js <GOOGLE_ACCESS_TOKEN>');
    console.log('You can get a token by clicking "Connect YouTube" in the dashboard and checking the network logs or console.');
  }

  const db = new Database();
  await db.initialize();
  
  const cm = new CredentialManager();
  await cm.initialize();
  
  const results = {
    firebase_config: 'FAIL',
    token_verification: 'FAIL',
    channel_info_fetch: 'FAIL',
    analytics_fetch: 'FAIL',
    upload_capability: 'FAIL'
  };

  // 1. Check Firebase Config
  try {
    const configPath = path.join(__dirname, 'firebase-applet-config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (config.oAuthClientId) {
      results.firebase_config = 'PASS';
      console.log('✅ Firebase/OAuth Client ID found');
    }
  } catch (e) {
    console.log('❌ Firebase config missing or invalid');
  }

  if (!token) {
    console.log('\n--- AUDIT SUMMARY (PARTIAL) ---');
    Object.entries(results).forEach(([k, v]) => console.log(`${k}: ${v}`));
    return;
  }

  // 2. Verify Token
  try {
    const response = await axios.get(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
    const config = JSON.parse(await fs.readFile(path.join(__dirname, 'firebase-applet-config.json'), 'utf8'));
    if (response.data.aud === config.oAuthClientId || response.data.azp === config.oAuthClientId) {
      results.token_verification = 'PASS';
      console.log('✅ Token verified successfully with Google');
    } else {
      console.log('❌ Token client ID mismatch');
    }
  } catch (e) {
    console.log('❌ Token verification failed:', e.response?.data || e.message);
  }

  // 3. Fetch Channel Info
  let channelId = null;
  if (results.token_verification === 'PASS') {
    try {
      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: token });
      const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
      
      const response = await youtube.channels.list({ part: 'snippet,statistics', mine: true });
      if (response.data.items && response.data.items.length > 0) {
        const channel = response.data.items[0];
        channelId = channel.id;
        results.channel_info_fetch = 'PASS';
        console.log(`✅ Fetched real channel: ${channel.snippet.title} (${channel.id})`);
        console.log(`📊 Subscribers: ${channel.statistics.subscriberCount}`);
      } else {
        console.log('❌ No channel found for this token');
      }
    } catch (e) {
      console.log('❌ Channel info fetch failed:', e.message);
    }
  }

  // 4. Check Analytics
  if (results.channel_info_fetch === 'PASS') {
    try {
      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: token });
      const analytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2Client });
      
      const now = new Date();
      const endDate = now.toISOString().split('T')[0];
      const startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      
      const response = await analytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'views,estimatedMinutesWatched,subscribersGained'
      });
      results.analytics_fetch = 'PASS';
      console.log('✅ Real analytics fetched successfully');
      if (response.data.rows) {
        console.log(`📈 Views (last 7 days): ${response.data.rows.reduce((a, b) => a + b[0], 0)}`);
      }
    } catch (e) {
      console.log('❌ Analytics fetch failed:', e.message);
    }
  }

  // 5. Check Upload Capability (Metadata check only)
  if (results.token_verification === 'PASS') {
    try {
      const grantedScopes = (await axios.get(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`)).data.scope.split(' ');
      if (grantedScopes.includes('https://www.googleapis.com/auth/youtube.upload')) {
        results.upload_capability = 'PASS';
        console.log('✅ Upload scope is present in token');
      } else {
        console.log('❌ Upload scope missing from token');
      }
    } catch (e) {
      console.log('❌ Scope check failed');
    }
  }

  console.log('\n--- AUDIT SUMMARY ---');
  Object.entries(results).forEach(([k, v]) => {
    const color = v === 'PASS' ? '\x1b[32m' : '\x1b[31m';
    console.log(`${k}: ${color}${v}\x1b[0m`);
  });
}

audit().catch(console.error);
