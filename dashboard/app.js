import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged } from 'firebase/auth';

let firebaseApp;
let firebaseAuth;
let cachedAccessToken = null;
let isSigningIn = false;

const ui = {
  state: null,
  currentView: 'overview',
  onboardingStep: 1,
  selectedNiches: new Set(),
  refreshing: false,
  toastTimer: null,
  authReady: false
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

async function initFirebase() {
  try {
    const res = await fetch('/api/config/firebase');
    const config = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(config.error || `Server HTTP ${res.status} loading Auth config`);
    }
    if (!config.apiKey || !config.projectId) {
      throw new Error('Auth configuration is missing required parameters (apiKey or projectId)');
    }
    firebaseApp = initializeApp(config);
    firebaseAuth = getAuth(firebaseApp);
    ui.authReady = true;
    ui.authError = null;
    
    onAuthStateChanged(firebaseAuth, async (_user) => {
      refreshDashboard(true);
    });
  } catch (error) {
    console.warn('YouTube Auth system notice:', error.message);
    ui.authReady = false;
    ui.authError = error.message;
  }
}

function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function apiKey() {
  return localStorage.getItem('yaa_api_key') || '';
}

function requestApiKey() {
  const key = prompt('Enter the API_KEY value from your .env. It stays in this browser only.', apiKey());
  if (key !== null) localStorage.setItem('yaa_api_key', key.trim());
  return key;
}

async function api(url, options = {}, retry = true) {
  const key = apiKey();
  const token = cachedAccessToken;
  
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(key ? { 'x-api-key': key } : {}),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 401 && retry) {
    // If backend returns 401, prompt operator for API_KEY (regardless of Firebase auth token)
    const newKey = requestApiKey();
    if (newKey !== null && newKey.trim().length > 0) {
      return api(url, options, false);
    }
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || response.statusText || 'Request failed');
    error.data = data;
    throw error;
  }
  return data;
}

function showToast(message, type = 'success') {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => toast.classList.add('hidden'), 4200);
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(value) {
  if (!value) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 8400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * View Management
 */
function switchView(viewId) {
  if (ui.state?.system?.setupRequired && viewId !== 'overview' && viewId !== 'settings') {
    showToast('Complete setup to access all features.', 'error');
    return;
  }

  ui.currentView = viewId;
  
  // Update nav UI
  $$('.nav-item, .mobile-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewId);
  });

  // Update views
  $$('.view').forEach(el => {
    el.classList.toggle('active', el.id === `${viewId}-view`);
  });

  // Update breadcrumb
  const breadcrumb = $('#breadcrumb');
  if (breadcrumb) {
    const viewNames = {
      overview: 'Overview',
      analytics: 'Analytics',
      growth: 'Growth Intelligence',
      stories: 'Story Universes',
      monetization: 'Monetization Readiness',
      library: 'Video Library',
      settings: 'Settings'
    };
    breadcrumb.textContent = viewNames[viewId] || 'Dashboard';
  }

  // Load view-specific data if needed
  if (viewId === 'analytics') renderAnalyticsView();
  if (viewId === 'growth') renderGrowthView();
  if (viewId === 'stories') renderStoriesView();
  if (viewId === 'monetization') renderMonetizationView();
  if (viewId === 'library') renderLibraryView();
  if (viewId === 'settings') renderSettingsView();
}

async function renderStoriesView() {
  try {
    const res = await api('/api/story/universes');
    const universes = res.universes || [];
    const container = $('#story-universes-container');
    if (!container || !universes.length) return;
    container.innerHTML = universes.map(u => `
      <div class="card mb-4">
        <div class="flex justify-between items-center mb-2">
          <h3>${escapeHTML(u.title)}</h3>
          <span class="status-badge status-online">Demand: ${u.audience_demand_score || 80}/100</span>
        </div>
        <p class="text-sm text-secondary mb-3">${escapeHTML(u.premise)}</p>
        <div class="text-xs text-muted mb-2">Episodes: ${u.episode_count || 0} | Status: ${escapeHTML(u.status)}</div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load stories:', err);
  }
}

async function renderMonetizationView() {
  try {
    const res = await api('/api/monetization/report');
    if (res.report) {
      if ($('#ypp-originality-score')) $('#ypp-originality-score').textContent = `${((res.report.originality_score || 1.0) * 100).toFixed(0)}%`;
      if ($('#ypp-reused-risk')) $('#ypp-reused-risk').textContent = (res.report.reused_content_risk || 'low').toUpperCase();
    }
  } catch (err) {
    console.error('Failed to load monetization:', err);
  }
}

/**
 * Onboarding Flow
 */
function showOnboarding(step = 1) {
  ui.onboardingStep = step;
  $('#onboarding-view').classList.add('active');
  $$('.onboarding-step-content').forEach(el => el.classList.add('hidden'));
  $(`#step-${step}`).classList.remove('hidden');
  
  $$('.step-dot').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.step) === step);
  });
}

async function connectYouTube() {
  if (isSigningIn) return;
  if (!firebaseAuth) {
    const reason = ui.authError
      ? `YouTube Auth setup required: ${ui.authError}`
      : 'YouTube Auth is not configured. Please set GOOGLE_OAUTH_CLIENT_ID and FIREBASE_API_KEY environment variables on Render.';
    showToast(reason, 'error');
    return;
  }
  isSigningIn = true;

  try {
    const provider = new GoogleAuthProvider();
    provider.addScope('https://www.googleapis.com/auth/youtube.upload');
    provider.addScope('https://www.googleapis.com/auth/youtube.readonly');
    provider.addScope('https://www.googleapis.com/auth/yt-analytics.readonly');
    
    const result = await signInWithPopup(firebaseAuth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain YouTube access token from Google.');
    }

    cachedAccessToken = credential.accessToken;

    // Send token to backend for secure storage and channel verification
    await api('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ accessToken: cachedAccessToken })
    });

    showToast('YouTube connected successfully!');
    
    // Refresh dashboard to get real channel info
    await refreshDashboard(true);
    if (ui.currentView === 'settings') renderSettingsView();
    
    // Update Step 1 UI
    if (ui.state.system.publishingConfigured) {
      $('#next-to-step-2').classList.remove('hidden');
      $('#connect-youtube-btn').classList.add('hidden');
      
      const channel = ui.state.profile || {};
      $('#channel-info').classList.remove('hidden');
      $('#channel-avatar').src = channel.profile_image || '';
      $('#channel-name').textContent = channel.channel_name || 'Connected Channel';
      $('#channel-stats').textContent = `${ui.state.stats.published || 0} videos published`;
    }
  } catch (error) {
    console.error('YouTube connection failed:', error);
    showToast(error.message, 'error');
  } finally {
    isSigningIn = false;
  }
}

async function completeOnboarding() {
  const referenceUrl = $('#reference-video-url')?.value || 'https://youtube.com';

  try {
    // Save Niche (Content Pillars)
    const niches = Array.from(ui.selectedNiches);
    await api('/api/operator/strategy', {
      method: 'PUT',
      body: JSON.stringify({
        objective: 'Grow the channel using AI automation',
        audience: 'Fans of WHAT IF scenarios in Hindi',
        contentPillars: niches.length ? niches : ['Science', 'Space', 'Apocalypse'],
        status: 'active'
      })
    });

    // Save Profile (Reference URL)
    await api('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({
        channelName: ui.state?.profile?.channel_name || 'ImagineX / FinalTube AI',
        visualStyle: referenceUrl ? `Inspired by ${referenceUrl}` : 'Cinematic 2D Illustration',
        brandVoice: 'Informative, engaging, and cinematic in Hindi',
        goal: 'Engage audience with hypothetical scenarios'
      })
    });

    // Mark setup as completed permanently in settings
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        setup_completed_at: new Date().toISOString(),
        daily_content_enabled: 'true',
        auto_publish_enabled: 'true',
        auto_public_publishing: 'true',
        video_resolution: '1080p',
        language: 'Hindi'
      })
    });

    showToast('Setup complete! Autonomous daily production active.');
    $('#onboarding-view').classList.remove('active');
    await refreshDashboard();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

/**
 * Data Rendering
 */
async function refreshDashboard(silent = false) {
  if (ui.refreshing) return;
  ui.refreshing = true;
  try {
    ui.state = await api('/api/dashboard');

    // Fetch real channel statistics if publishing is configured
    if (ui.state.system?.publishingConfigured) {
      try {
        const channelResp = await api('/api/analytics/channel');
        if (channelResp.success && channelResp.result?.available) {
          ui.state.channelSnapshot = channelResp.result;
        }
      } catch (err) {
        console.warn('Failed to load channel snapshot:', err);
      }
    }

    renderOverview();
    
    renderOverview();
    
    // Check if onboarding is needed (only if setup is required AND onboarding is NOT completed)
    const onboardingNeeded = ui.state.system.setupRequired && !ui.state.system.onboardingCompleted;
    if (onboardingNeeded && !$('#onboarding-view').classList.contains('active')) {
      showOnboarding(1);
    } else if (!onboardingNeeded) {
      $('#onboarding-view').classList.remove('active');
    }
  } catch (error) {
    showToast('Failed to refresh data: ' + error.message, 'error');
  } finally {
    ui.refreshing = false;
  }
}

function renderOverview() {
  const state = ui.state;
  if (!state) return;

  // Connection Prompt
  const connectPrompt = $('#connect-prompt');
  if (state.system.publishingConfigured) {
    connectPrompt.classList.add('hidden');
  } else {
    connectPrompt.classList.remove('hidden');
    $('#dashboard-connect-btn').onclick = connectYouTube;
  }

  // Stats
  const snap = state.channelSnapshot;
  const channelData = snap?.channel || {};
  const recentData = snap?.recent || {};

  $('#stat-views').textContent = channelData.views !== undefined ? channelData.views.toLocaleString() : (state.stats.views || 0).toLocaleString();
  $('#stat-subscribers').textContent = channelData.subscribers !== undefined ? channelData.subscribers.toLocaleString() : (state.stats.subscribers || 0).toLocaleString();
  $('#stat-gained').textContent = recentData.subscribersGained !== undefined ? recentData.subscribersGained.toLocaleString() : (state.stats.subscribersGained || 0).toLocaleString();
  $('#stat-watchtime').textContent = recentData.watchHours !== undefined ? recentData.watchHours.toLocaleString() : (state.stats.watchHours || 0).toLocaleString();

  // Render Readiness Checklist
  const readinessContainer = $('#readiness-checklist');
  if (readinessContainer && state.system?.readinessChecklist) {
    const list = state.system.readinessChecklist;
    const items = [
      { label: 'Channel Connected', ok: list.channelConnected, hint: list.hints.channelConnected },
      { label: 'Onboarding Complete', ok: list.onboardingCompleted, hint: list.hints.onboardingCompleted },
      { label: 'AI Credentials Ready', ok: list.aiCredentialsReady, hint: list.hints.aiCredentialsReady },
      { label: 'Image Generation Ready', ok: list.imageGenerationReady, hint: list.hints.imageGenerationReady },
      { label: 'Voice Generation Ready', ok: list.voiceGenerationReady, hint: list.hints.voiceGenerationReady },
      { label: 'FFmpeg Rendering Ready', ok: list.ffmpegRenderingReady, hint: list.hints.ffmpegRenderingReady },
      { label: 'YouTube Publishing Ready', ok: list.youtubePublishingReady, hint: list.hints.youtubePublishingReady },
      { label: 'Scheduler Active', ok: list.schedulerActive, hint: list.hints.schedulerActive }
    ];

    readinessContainer.innerHTML = items.map(item => `
      <div class="card bg-secondary p-3 flex items-center justify-between">
        <div>
          <div class="font-bold text-sm flex items-center gap-2">
            <span class="${item.ok ? 'text-success' : 'text-error'}">${item.ok ? '✓' : '✗'}</span>
            ${escapeHTML(item.label)}
          </div>
          ${item.hint ? `<div class="text-xs text-muted mt-1">${escapeHTML(item.hint)}</div>` : ''}
        </div>
        <div class="status-badge ${item.ok ? 'status-online' : 'status-error'}">
          ${item.ok ? 'Ready' : 'Pending'}
        </div>
      </div>
    `).join('');
  }

  const editSettingsBtn = $('#overview-edit-settings-btn');
  if (editSettingsBtn) {
    editSettingsBtn.onclick = () => switchView('settings');
  }

  // Production Jobs
  const jobsList = $('#production-jobs-list');
  const activeJobs = state.jobs.filter(j => ['queued', 'running', 'failed'].includes(j.status));
  
  if (activeJobs.length === 0) {
    jobsList.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-8">No active production jobs</td></tr>';
  } else {
    jobsList.innerHTML = activeJobs.slice(0, 5).map(job => `
      <tr>
        <td>
          <div class="font-semibold">${escapeHTML(job.topic || 'Auto-selected')}</div>
          <div class="text-xs text-muted">${timeAgo(job.created_at)}</div>
        </td>
        <td><span class="text-xs font-mono">${escapeHTML(job.stage)}</span></td>
        <td><span class="status-badge ${job.status === 'running' ? 'status-online' : job.status === 'failed' ? 'status-error' : ''}">${escapeHTML(job.status)}</span></td>
        <td style="width: 150px;">
          <div class="flex items-center gap-2">
            <div class="progress flex-1"><i style="width: ${job.progress}%"></i></div>
            <span class="text-xs">${job.progress}%</span>
          </div>
        </td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="openContent('${job.production_id}')" ${!job.production_id ? 'disabled' : ''}>View</button>
        </td>
      </tr>
    `).join('');
  }

  // Recent Content
  const contentList = $('#recent-content-list');
  const published = state.pipeline.filter(p => p.status === 'published' || p.schedule_status === 'published');
  
  if (published.length === 0) {
    contentList.innerHTML = '<div class="col-span-full py-8 text-center text-muted">No published videos yet</div>';
  } else {
    contentList.innerHTML = published.slice(0, 4).map(item => `
      <div class="card video-card" onclick="openContent('${item.id}')">
        <div class="video-thumb">
          ${item.hasThumbnail ? `<img src="/api/content/${item.id}/asset/thumbnail" alt="">` : '<div class="flex items-center justify-center h-full bg-inset">No Thumb</div>'}
        </div>
        <div class="p-4">
          <div class="font-bold line-clamp-2 mb-1">${escapeHTML(item.title)}</div>
          <div class="text-xs text-muted">${formatDate(item.created_at)}</div>
        </div>
      </div>
    `).join('');
  }

  // System Status
  const statusBadge = $('#system-status');
  if (state.system.setupRequired && !state.system.onboardingCompleted) {
    statusBadge.textContent = 'Setup Required';
    statusBadge.className = 'status-badge status-error';
  } else if (state.system.automationPaused) {
    statusBadge.textContent = 'Paused';
    statusBadge.className = 'status-badge';
  } else {
    statusBadge.textContent = 'Agent Online';
    statusBadge.className = 'status-badge status-online';
  }
}

function renderAnalyticsView() {
  const analytics = ui.state?.analytics || {};
  const performers = $('#performance-table-body');
  
  if (!analytics.topPerformers || analytics.topPerformers.length === 0) {
    performers.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-8">No performance data available</td></tr>';
  } else {
    performers.innerHTML = analytics.topPerformers.map(item => `
      <tr>
        <td><div class="font-semibold line-clamp-1">${escapeHTML(item.title)}</div></td>
        <td>${(item.performance?.views || 0).toLocaleString()}</td>
        <td>${(item.performance?.likes || 0).toLocaleString()}</td>
        <td>${(item.performance?.comments || 0).toLocaleString()}</td>
        <td>${(item.performance?.watchHours || 0).toFixed(1)}h</td>
        <td><span class="status-badge status-online">${item.performance?.grade || 'B'}</span></td>
      </tr>
    `).join('');
  }

  // Render Charts (Mocking for now, could use SVG or Canvas)
  renderMiniChart('#chart-views', [10, 40, 25, 60, 45, 80, 95]);
  renderMiniChart('#chart-subscribers', [5, 15, 10, 30, 25, 45, 50]);
  renderMiniChart('#chart-watchtime', [20, 30, 25, 50, 40, 70, 65]);
}

function renderMiniChart(selector, data) {
  const container = $(selector);
  if (!container) return;
  
  const width = 200;
  const height = 80;
  const max = Math.max(...data);
  const step = width / (data.length - 1);
  
  let points = data.map((v, i) => `${i * step},${height - (v / max * height)}`).join(' ');
  
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width: 100%; height: 100%;">
      <polyline points="${points}" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round" />
      <path d="M 0 ${height} ${points} L ${width} ${height} Z" fill="var(--primary)" fill-opacity="0.1" />
    </svg>
  `;
}

function renderGrowthView() {
  const state = ui.state;
  const agent = state.system;
  
  $('#growth-agent-status').innerHTML = `
    <div class="status-badge ${agent.autonomousRunning ? 'status-online' : ''}">${agent.autonomousRunning ? 'Running' : 'Idle'}</div>
  `;
  
  const recommended = $('#recommended-topic');
  const rationale = $('#topic-rationale');
  
  const ideas = state.ideas || [];
  if (ideas.length > 0) {
    recommended.textContent = ideas[0].topic;
    rationale.textContent = ideas[0].rationale || 'Top trending topic in your niche.';
  } else {
    recommended.textContent = 'Analysis required';
    rationale.textContent = 'Run growth analysis to identify trends.';
  }

  const activeJob = state.jobs.find(j => ['queued', 'running'].includes(j.status));
  if (activeJob) {
    $('#growth-production-status').textContent = `Producing: ${activeJob.topic || 'New Video'}`;
    $('#growth-production-steps').innerHTML = renderProductionSteps(activeJob);
  } else {
    $('#growth-production-status').textContent = 'No active job';
    $('#growth-production-steps').innerHTML = '<div class="text-sm text-muted">Ready for next production cycle.</div>';
  }

  const insightsList = $('#growth-insights-list');
  const insights = state.learning?.recommendations || [];
  
  if (insights.length === 0) {
    insightsList.innerHTML = '<div class="empty text-muted">No insights yet. Run analysis to start.</div>';
  } else {
    insightsList.innerHTML = insights.map(item => `
      <div class="card p-4">
        <div class="flex justify-between items-start mb-2">
          <div class="font-bold">${escapeHTML(item.title)}</div>
          <span class="status-badge status-online text-xs">${escapeHTML(item.confidence)} confidence</span>
        </div>
        <p class="text-sm text-secondary mb-3">${escapeHTML(item.rationale)}</p>
        <div class="flex gap-2">
          <button class="btn btn-ghost btn-sm" onclick="approveLearning('${item.id}')">Approve</button>
          <button class="btn btn-ghost btn-sm" onclick="rejectLearning('${item.id}')">Dismiss</button>
        </div>
      </div>
    `).join('');
  }
}

function renderLibraryView() {
  const grid = $('#library-video-grid');
  const items = ui.state.pipeline.filter(p => p.status === 'published' || p.schedule_status === 'published');
  
  if (items.length === 0) {
    grid.innerHTML = '<div class="col-span-full py-12 text-center text-muted">No videos in your library yet.</div>';
  } else {
    grid.innerHTML = items.map(item => `
      <div class="card video-card" onclick="openContent('${item.id}')">
        <div class="video-thumb">
          ${item.hasThumbnail ? `<img src="/api/content/${item.id}/asset/thumbnail" alt="">` : '<div class="flex items-center justify-center h-full bg-inset">No Thumb</div>'}
          <div class="status-badge status-online absolute bottom-2 right-2 text-xs">Published</div>
        </div>
        <div class="p-4">
          <div class="font-bold line-clamp-2 mb-1">${escapeHTML(item.title)}</div>
          <div class="flex justify-between items-center text-xs text-muted">
            <span>${formatDate(item.created_at)}</span>
            <span>${(item.performance_score || 0)} pts</span>
          </div>
        </div>
      </div>
    `).join('');
  }
}

function updateOperatorKeyUI() {
  const hasKey = Boolean(apiKey());
  const badge = $('#operator-key-status-badge');
  const text = $('#operator-key-status-text');
  const input = $('#operator-api-key-input');
  if (input) input.value = ''; // Never display raw key in HTML
  if (badge) {
    badge.textContent = hasKey ? 'Configured' : 'Not configured';
    badge.className = `status-badge ${hasKey ? 'status-online' : ''}`;
  }
  if (text) {
    text.textContent = hasKey ? 'API key active in this browser' : 'No API key stored in this browser';
  }
}

async function renderSettingsView() {
  const profile = ui.state.profile || {};
  const form = $('#settings-form');
  
  updateOperatorKeyUI();
  form.elements.channelName.value = profile.channel_name || '';
  form.elements.referenceUrl.value = profile.visual_style?.replace('Inspired by ', '') || '';

  // Load Automation Settings
  try {
    const settings = await api('/api/settings/automation');
    $('#setting-master-switch').checked = settings.masterSwitch;
    $('#setting-auto-upload').checked = settings.autoUpload;
    $('#setting-auto-public').checked = settings.autoPublic;
    $('#setting-approval-required').checked = settings.approvalRequired;
  } catch (error) {
    console.error('Failed to load automation settings:', error);
  }

  // YouTube Connection Status
  const badge = $('#youtube-connection-badge');
  const accountName = $('#youtube-account-name');
  const actionBtn = $('#youtube-action-btn');
  const isConnected = ui.state.system.publishingConfigured;

  if (isConnected) {
    badge.textContent = 'Connected';
    badge.className = 'status-badge status-online';
    accountName.textContent = profile.channel_name || 'Authorized Channel';
    actionBtn.textContent = 'Disconnect';
    actionBtn.onclick = disconnectYouTube;
  } else {
    badge.textContent = 'Disconnected';
    badge.className = 'status-badge';
    accountName.textContent = 'No channel connected';
    actionBtn.textContent = 'Connect';
    actionBtn.onclick = connectYouTube;
  }
}

async function disconnectYouTube() {
  if (!confirm('Are you sure you want to disconnect your YouTube channel?')) return;
  try {
    await api('/api/auth/disconnect', { method: 'POST' });
    showToast('YouTube disconnected.');
    await refreshDashboard(true);
    renderSettingsView();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

/**
 * Actions
 */
async function openContent(id) {
  if (!id) return;
  
  $('#loading')?.classList.add('active');
  try {
    const item = await api(`/api/content/${encodeURIComponent(id)}`);
    const data = item.editorData || {};
    const title = data.title || item.seo?.title || item.script?.title || item.strategy?.topic || 'Untitled Video';
    
    $('#detail-title').textContent = title;
    const container = $('#content-detail');
    
    container.innerHTML = `
      <div class="flex flex-direction-column gap-6">
        <div class="video-preview-large card bg-inset" style="padding: 0; overflow: hidden; aspect-ratio: 16/9;">
          ${item.assetUrls.video 
            ? `<video controls style="width: 100%; height: 100%;"><source src="${item.assetUrls.video}" type="video/mp4"></video>`
            : item.assetUrls.thumbnail 
              ? `<img src="${item.assetUrls.thumbnail}" style="width: 100%; height: 100%; object-fit: cover;">`
              : '<div class="flex items-center justify-center h-full text-muted">Preview not available</div>'}
        </div>
        
        <div class="grid-2 gap-6">
          <div class="flex flex-direction-column gap-4">
            <h4 class="text-sm uppercase tracking-wider text-muted">Metadata</h4>
            <div class="card bg-secondary p-4">
              <div class="mb-4">
                <label class="text-xs font-bold text-muted uppercase block mb-1">Description</label>
                <div class="text-sm line-clamp-3">${escapeHTML(item.seo?.description || 'No description')}</div>
              </div>
              <div>
                <label class="text-xs font-bold text-muted uppercase block mb-1">Tags</label>
                <div class="flex flex-wrap gap-1">
                  ${(item.seo?.tags || []).map(t => `<span class="status-badge text-xs">${escapeHTML(t)}</span>`).join('')}
                </div>
              </div>
            </div>
          </div>
          
          <div class="flex flex-direction-column gap-4">
            <h4 class="text-sm uppercase tracking-wider text-muted">Assets & Publishing</h4>
            <div class="card bg-secondary p-4 flex flex-direction-column gap-2">
              <a href="${item.assetUrls.video || '#'}" download class="btn btn-secondary btn-sm w-full" ${!item.assetUrls.video ? 'disabled' : ''}>
                Download MP4
              </a>
              <a href="${item.assetUrls.thumbnail || '#'}" download class="btn btn-secondary btn-sm w-full" ${!item.assetUrls.thumbnail ? 'disabled' : ''}>
                Download Thumbnail
              </a>
              <div class="mt-4 pt-4 border-t border-dashed">
                <div class="flex justify-between items-center text-sm">
                  <span class="text-muted">Status</span>
                  <span class="status-badge status-online">${escapeHTML(item.schedule?.status || item.status)}</span>
                </div>
                ${item.schedule?.youtube_url ? `
                  <a href="${item.schedule.youtube_url}" target="_blank" class="btn btn-primary btn-sm w-full mt-4">
                    View on YouTube
                  </a>
                ` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    $('#content-dialog').showModal();
    $('#content-dialog').classList.remove('hidden');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#loading')?.classList.remove('active');
  }
}

function renderProductionSteps(job) {
  const stages = [
    { id: 'strategy', label: 'Research' },
    { id: 'script', label: 'Script' },
    { id: 'thumbnail', label: 'Visuals' },
    { id: 'seo', label: 'SEO' },
    { id: 'production', label: 'Rendering' },
    { id: 'quality_review', label: 'Review' }
  ];
  
  const currentStageIndex = stages.findIndex(s => s.id === job.stage);
  
  return stages.map((stage, index) => {
    const isCompleted = index < currentStageIndex || job.status === 'completed';
    const isActive = index === currentStageIndex && job.status === 'running';
    
    return `
      <div class="progress-step">
        <div class="step-line-container">
          <div class="step-circle ${isCompleted ? 'completed' : isActive ? 'active' : ''}">
            ${isCompleted ? '✓' : index + 1}
          </div>
          ${index < stages.length - 1 ? '<div class="step-line"></div>' : ''}
        </div>
        <div class="step-content">
          <div class="step-title">${stage.label}</div>
          <div class="step-desc">${isActive ? `In progress (${job.progress}%)` : isCompleted ? 'Completed' : 'Pending'}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function startProduction() {
  const form = $('#generate-form');
  const values = Object.fromEntries(new FormData(form));
  
  try {
    await api('/generate', {
      method: 'POST',
      body: JSON.stringify(values)
    });
    showToast('Production started successfully!');
    $('#generate-dialog').classList.add('hidden');
    refreshDashboard();
    switchView('overview');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function runGrowthAnalysis() {
  const btn = $('#run-growth-btn');
  btn.disabled = true;
  btn.textContent = 'Analyzing...';
  try {
    await api('/api/growth/cycle', { method: 'POST' });
    showToast('Growth analysis complete! New plan generated.');
    await refreshDashboard();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Growth Analysis';
  }
}

/**
 * Event Listeners
 */
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();
  refreshDashboard();
  setInterval(refreshDashboard, 8000);

  // Navigation
  $$('.nav-item, .mobile-nav-item').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Modals
  $('#open-generate-dialog').addEventListener('click', () => $('#generate-dialog').classList.remove('hidden'));
  $('#mobile-create-btn').addEventListener('click', () => $('#generate-dialog').classList.remove('hidden'));
  
  $$('.close-dialog').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.modal-backdrop').classList.add('hidden');
    });
  });

  $('#submit-generate').addEventListener('click', startProduction);

  // Onboarding
  $('#connect-youtube-btn').addEventListener('click', connectYouTube);
  $('#next-to-step-2').addEventListener('click', () => showOnboarding(2));
  $('#back-to-step-1').addEventListener('click', () => showOnboarding(1));
  $('#next-to-step-3').addEventListener('click', () => showOnboarding(3));
  $('#back-to-step-2').addEventListener('click', () => showOnboarding(2));
  $('#complete-onboarding').addEventListener('click', completeOnboarding);

  // Niche Selection
  $$('.niche-item').forEach(el => {
    el.addEventListener('click', () => {
      const niche = el.dataset.niche;
      if (ui.selectedNiches.has(niche)) {
        ui.selectedNiches.delete(niche);
        el.classList.remove('selected');
      } else {
        ui.selectedNiches.add(niche);
        el.classList.add('selected');
      }
    });
  });

  // Settings
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const values = Object.fromEntries(new FormData(form));
    
    try {
      await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          channelName: values.channelName,
          visualStyle: values.referenceUrl ? `Inspired by ${values.referenceUrl}` : undefined
        })
      });

      // Save Automation Settings
      await api('/api/settings/automation', {
        method: 'POST',
        body: JSON.stringify({
          masterSwitch: $('#setting-master-switch').checked,
          autoUpload: $('#setting-auto-upload').checked,
          autoPublic: $('#setting-auto-public').checked,
          approvalRequired: $('#setting-approval-required').checked
        })
      });

      showToast('Settings saved!');
      refreshDashboard(true);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  // Operator API Key actions
  const saveKeyBtn = $('#save-operator-key-btn');
  if (saveKeyBtn) {
    saveKeyBtn.addEventListener('click', () => {
      const input = $('#operator-api-key-input');
      const val = input ? input.value.trim() : '';
      if (!val) {
        showToast('Please enter an API key', 'error');
        return;
      }
      localStorage.setItem('yaa_api_key', val);
      updateOperatorKeyUI();
      showToast('Operator API Key saved locally!');
    });
  }

  const clearKeyBtn = $('#clear-operator-key-btn');
  if (clearKeyBtn) {
    clearKeyBtn.addEventListener('click', () => {
      localStorage.removeItem('yaa_api_key');
      updateOperatorKeyUI();
      showToast('Operator API Key cleared');
    });
  }

  // Growth
  const runGrowthBtn = $('#run-growth-btn');
  if (runGrowthBtn) runGrowthBtn.addEventListener('click', runGrowthAnalysis);

  // Refresh Button
  $('#refresh-data').addEventListener('click', () => refreshDashboard());
});
