const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { Logger } = require('../utils/logger');

class FirestoreDatabase {
  constructor(options = {}) {
    this.logger = new Logger('FirestoreDatabase');
    this.projectId = options.projectId || process.env.FIREBASE_PROJECT_ID || 'finalept-n8';
    this.credentialsBase64 = options.credentialsBase64 || process.env.FIREBASE_ADMIN_CREDENTIALS || '';
    this.db = null;
    this.app = null;
    this.isInitialized = false;
  }

  generateId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  async initialize() {
    try {
      this.logger.info(`Initializing Firestore connection for project: ${this.projectId}...`);

      const appName = `finaltube-${this.generateId('app')}`;
      const appOptions = {
        projectId: this.projectId
      };

      if (this.credentialsBase64) {
        try {
          const rawJson = Buffer.from(this.credentialsBase64, 'base64').toString('utf8');
          const serviceAccount = JSON.parse(rawJson);
          appOptions.credential = admin.credential.cert(serviceAccount);
          this.logger.info('Using service account credentials provided via environment variable.');
        } catch (credErr) {
          this.logger.warn(`Failed to parse FIREBASE_ADMIN_CREDENTIALS: ${credErr.message}`);
        }
      } else if (process.env.FIRESTORE_EMULATOR_HOST) {
        this.logger.info(`Connecting to local Firestore emulator at: ${process.env.FIRESTORE_EMULATOR_HOST}`);
      }

      this.app = admin.initializeApp(appOptions, appName);
      this.db = getFirestore(this.app);

      // Configure timestamp behavior
      this.db.settings({ ignoreUndefinedProperties: true });

      this.isInitialized = true;
      this.logger.success('Firestore client initialized successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize FirestoreDatabase:', error);
      throw error;
    }
  }

  async close() {
    if (this.app) {
      try {
        await this.app.delete();
      } catch (_e) {
        // App cleanup error ignored
      }
      this.app = null;
      this.db = null;
      this.isInitialized = false;
    }
  }

  // 1. Content Strategy
  async saveContentStrategy(strategy) {
    const id = this.generateId('strategy');
    const docData = {
      id,
      topic: strategy.topic,
      angle: strategy.angle,
      target_audience: strategy.targetAudience || strategy.target_audience,
      content_type: strategy.contentType || strategy.content_type,
      keywords: strategy.keywords || [],
      estimated_views: strategy.estimatedViews || strategy.estimated_views || 0,
      best_publish_time: strategy.bestPublishTime || strategy.best_publish_time || null,
      competitor_analysis: strategy.competitorAnalysis || strategy.competitor_analysis || {},
      created_at: new Date().toISOString()
    };
    await this.db.collection('content_strategies').doc(id).set(docData);
    return id;
  }

  async getContentHistory() {
    const snap = await this.db.collection('content_history').orderBy('publish_date', 'desc').get();
    return snap.docs.map(doc => doc.data());
  }

  // 2. Scripts
  async saveScript(script) {
    const id = this.generateId('script');
    const docData = {
      id,
      strategy_id: script.strategyId || script.strategy_id || null,
      title: script.title,
      hook: script.hook || null,
      introduction: script.introduction || null,
      main_content: script.mainContent || script.main_content || '',
      conclusion: script.conclusion || null,
      call_to_action: script.callToAction || script.call_to_action || null,
      full_script: script.fullScript || script.full_script || '',
      duration: script.duration || '',
      tone: script.tone || '',
      pacing: script.pacing || '',
      keywords: script.keywords || [],
      created_at: new Date().toISOString()
    };
    await this.db.collection('scripts').doc(id).set(docData);
    return id;
  }

  // 3. Thumbnails
  async saveThumbnail(thumbnail) {
    const id = this.generateId('thumbnail');
    const docData = {
      id,
      script_id: thumbnail.scriptId || thumbnail.script_id || null,
      path: thumbnail.path,
      concept: thumbnail.concept || null,
      prompt: thumbnail.prompt || '',
      dimensions: thumbnail.dimensions || null,
      file_size: thumbnail.fileSize || thumbnail.file_size || 0,
      created_at: new Date().toISOString()
    };
    await this.db.collection('thumbnails').doc(id).set(docData);
    return id;
  }

  // 4. SEO
  async saveSEOData(seoData) {
    const id = this.generateId('seo');
    const docData = {
      id,
      script_id: seoData.scriptId || seoData.script_id || null,
      title: seoData.title,
      description: seoData.description,
      tags: seoData.tags || [],
      hashtags: seoData.hashtags || [],
      chapters: seoData.chapters || [],
      end_screen: seoData.endScreen || seoData.end_screen || null,
      seo_score: seoData.seoScore || seoData.seo_score || 0,
      metadata: seoData.metadata || {},
      created_at: new Date().toISOString()
    };
    await this.db.collection('seo_data').doc(id).set(docData);
    return id;
  }

  // 5. Productions
  async saveProductionData(production) {
    const docRef = this.db.collection('productions').doc(production.id);
    const docData = {
      id: production.id,
      status: production.status || 'processing',
      assets: production.assets || {},
      timeline: production.timeline || {},
      scheduled_publish_time: production.scheduledPublishTime || production.scheduled_publish_time || null,
      priority: production.priority !== undefined ? production.priority : 50,
      estimated_duration: production.estimatedDuration || production.estimated_duration || null,
      updated_at: new Date().toISOString()
    };
    await docRef.set(docData, { merge: true });
    return production.id;
  }

  async updateProductionData(production) {
    await this.saveProductionData(production);
  }

  async updateProductionStatus(productionId, status) {
    await this.db.collection('productions').doc(productionId).set({
      status,
      updated_at: new Date().toISOString()
    }, { merge: true });
  }

  async getProductionPipeline() {
    const snap = await this.db.collection('productions').orderBy('priority', 'desc').get();
    return snap.docs.map(doc => doc.data());
  }

  async saveProductionSnapshot(production) {
    const docRef = this.db.collection('production_snapshots').doc(production.id);
    await docRef.set({
      production_id: production.id,
      strategy: production.strategy || {},
      script: production.script || {},
      thumbnail: production.thumbnail || {},
      seo: production.seo || {},
      updated_at: new Date().toISOString()
    }, { merge: true });
  }

  async getProductionBundle(productionId) {
    const prodDoc = await this.db.collection('productions').doc(productionId).get();
    if (!prodDoc.exists) return null;
    const prod = prodDoc.data();

    const [snapshotDoc, reviewDoc, scheduleSnap, provenance, discoverability, scenes, shorts] = await Promise.all([
      this.db.collection('production_snapshots').doc(productionId).get(),
      this.db.collection('content_reviews').doc(productionId).get(),
      this.db.collection('publish_schedule').where('production_id', '==', productionId).limit(1).get(),
      this.getContentProvenance(productionId),
      this.getLatestDiscoverabilityAudit(productionId, 'youtube'),
      this.listProductionScenes(productionId),
      this.listShortClips(productionId)
    ]);

    const snapshot = snapshotDoc.exists ? snapshotDoc.data() : {};
    const review = reviewDoc.exists ? reviewDoc.data() : {};
    const schedule = !scheduleSnap.empty ? scheduleSnap.docs[0].data() : null;
    const sceneRevisions = scenes.length ? await this.listProductionSceneRevisions(productionId, 50) : [];

    return {
      ...prod,
      assets: prod.assets || {},
      timeline: prod.timeline || {},
      strategy: snapshot.strategy || {},
      script: snapshot.script || {},
      thumbnail: snapshot.thumbnail || {},
      seo: snapshot.seo || {},
      editorData: review.editor_data || {},
      qualityChecks: review.quality_checks || [],
      review_status: review.status || 'needs_review',
      review_notes: review.review_notes || null,
      reviewed_at: review.reviewed_at || null,
      schedule: schedule ? { ...schedule, metadata: schedule.metadata || {} } : null,
      provenance: provenance || {
        sources: [], claims: [], containsSyntheticMedia: false, status: 'not_required',
        summary: { sourceCount: 0, verifiedSources: 0, claimCount: 0, resolvedClaims: 0, highRiskClaims: 0, unresolvedClaims: 0 }
      },
      discoverability,
      scenes,
      sceneRevisions,
      shorts
    };
  }

  async getPipelineOverview(limit = 50) {
    const snap = await this.db.collection('productions').limit(limit).get();
    const rows = await Promise.all(snap.docs.map(async doc => {
      const prod = doc.data();
      const [snapDoc, reviewDoc, schedSnap] = await Promise.all([
        this.db.collection('production_snapshots').doc(prod.id).get(),
        this.db.collection('content_reviews').doc(prod.id).get(),
        this.db.collection('publish_schedule').where('production_id', '==', prod.id).limit(1).get()
      ]);
      const s = snapDoc.exists ? snapDoc.data() : {};
      const r = reviewDoc.exists ? reviewDoc.data() : {};
      const sch = !schedSnap.empty ? schedSnap.docs[0].data() : null;

      const strategy = s.strategy || {};
      const script = s.script || {};
      const seo = s.seo || {};
      const assets = prod.assets || {};

      return {
        id: prod.id,
        status: prod.status,
        assets,
        timeline: prod.timeline || {},
        scheduled_publish_time: prod.scheduled_publish_time,
        priority: prod.priority,
        estimated_duration: prod.estimated_duration,
        created_at: prod.created_at,
        strategy,
        script,
        seo,
        review_status: r.status || null,
        qualityChecks: r.quality_checks || [],
        schedule_id: sch?.id || null,
        schedule_status: sch?.status || null,
        publish_time: sch?.publish_time || null,
        youtube_url: sch?.youtube_url || null,
        error_message: sch?.error_message || null,
        title: seo.title || script.title || strategy.topic || prod.id,
        topic: strategy.topic || '',
        hasVideo: Boolean(assets.finalVideo?.path && !assets.finalVideo?.simulated),
        hasThumbnail: Boolean(assets.thumbnail?.path)
      };
    }));
    return rows;
  }

  // 6. Generation Jobs & Checkpoints
  async createGenerationJob(input = {}) {
    const id = this.generateId('job');
    const details = {
      strategyContext: input.strategyContext || {},
      resumeCount: 0,
      reusedStages: []
    };
    const docData = {
      id,
      topic: input.topic || null,
      style: input.style || null,
      length: input.length || 'medium',
      source: input.source || 'manual',
      status: 'queued',
      stage: 'queued',
      progress: 0,
      details,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await this.db.collection('generation_jobs').doc(id).set(docData);
    return this.getGenerationJob(id);
  }

  async getGenerationJob(id) {
    const doc = await this.db.collection('generation_jobs').doc(id).get();
    if (!doc.exists) return null;
    const data = doc.data();
    return { ...data, cancelRequested: Boolean(data.cancel_requested) };
  }

  async updateGenerationJob(id, changes = {}) {
    const current = await this.getGenerationJob(id);
    if (!current) return null;
    const details = { ...(current.details || {}), ...(changes.details || {}) };
    const patch = {
      status: changes.status ?? current.status,
      stage: changes.stage ?? current.stage,
      progress: changes.progress ?? current.progress,
      production_id: changes.productionId ?? current.production_id ?? null,
      title: changes.title ?? current.title ?? null,
      error: changes.error === undefined ? current.error : changes.error,
      details,
      cancel_requested: changes.cancelRequested === undefined ? current.cancel_requested || 0 : Number(changes.cancelRequested),
      completed_at: changes.completedAt === undefined ? current.completed_at || null : changes.completedAt,
      updated_at: new Date().toISOString()
    };
    await this.db.collection('generation_jobs').doc(id).set(patch, { merge: true });
    return this.getGenerationJob(id);
  }

  async listGenerationJobs(limit = 30) {
    const snap = await this.db.collection('generation_jobs').limit(limit).get();
    return Promise.all(snap.docs.map(async doc => {
      const job = doc.data();
      job.checkpoints = await this.listGenerationCheckpoints(job.id);
      job.mediaTasks = await this.listMediaGenerationTasks(job.id);
      return job;
    }));
  }

  async saveGenerationCheckpoint(jobId, stage, changes = {}) {
    const current = await this.getGenerationCheckpoint(jobId, stage);
    const artifact = changes.artifact === undefined ? current?.artifact : changes.artifact;
    const attemptCount = changes.incrementAttempt
      ? Number(current?.attempt_count || 0) + 1
      : changes.attemptCount ?? current?.attempt_count ?? 0;

    const docRef = this.db.collection('generation_jobs').doc(jobId).collection('checkpoints').doc(stage);
    const data = {
      job_id: jobId,
      stage,
      status: changes.status ?? current?.status ?? 'pending',
      artifact: artifact || null,
      attempt_count: attemptCount,
      error: changes.error === undefined ? current?.error ?? null : changes.error,
      started_at: changes.startedAt === undefined ? current?.started_at ?? null : changes.startedAt,
      completed_at: changes.completedAt === undefined ? current?.completed_at ?? null : changes.completedAt,
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return this.getGenerationCheckpoint(jobId, stage);
  }

  async getGenerationCheckpoint(jobId, stage) {
    const doc = await this.db.collection('generation_jobs').doc(jobId).collection('checkpoints').doc(stage).get();
    return doc.exists ? doc.data() : null;
  }

  async listGenerationCheckpoints(jobId) {
    const snap = await this.db.collection('generation_jobs').doc(jobId).collection('checkpoints').get();
    return snap.docs.map(d => d.data());
  }

  async deleteGenerationCheckpoints(jobId, stages = []) {
    if (!stages.length) return;
    const batch = this.db.batch();
    for (const stage of stages) {
      const ref = this.db.collection('generation_jobs').doc(jobId).collection('checkpoints').doc(stage);
      batch.delete(ref);
    }
    await batch.commit();
  }

  // 7. Media Generation Tasks
  async createMediaGenerationTask(input = {}) {
    const id = this.generateId('media');
    const docRef = this.db.collection('media_generation_tasks').doc(id);
    const data = {
      id,
      job_id: input.jobId || null,
      production_id: input.productionId || null,
      scene_index: input.sceneIndex,
      provider: input.provider,
      model: input.model,
      status: input.status || 'submitting',
      request: input.request || {},
      provider_data: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await docRef.set(data);
    return data;
  }

  async findMediaGenerationTask(jobId, sceneIndex, provider) {
    const snap = await this.db.collection('media_generation_tasks')
      .where('job_id', '==', jobId || null)
      .where('scene_index', '==', sceneIndex)
      .where('provider', '==', provider)
      .limit(1)
      .get();
    return snap.empty ? null : snap.docs[0].data();
  }

  async updateMediaGenerationTask(id, changes = {}) {
    const docRef = this.db.collection('media_generation_tasks').doc(id);
    const doc = await docRef.get();
    if (!doc.exists) return null;
    const current = doc.data();

    const patch = {
      model: changes.model ?? current.model,
      external_task_id: changes.externalTaskId ?? current.external_task_id ?? null,
      status: changes.status ?? current.status,
      provider_data: changes.providerData ?? current.provider_data ?? {},
      output_path: changes.outputPath ?? current.output_path ?? null,
      error: changes.error === undefined ? current.error : changes.error,
      completed_at: changes.completedAt === undefined ? current.completed_at : changes.completedAt,
      updated_at: new Date().toISOString()
    };
    await docRef.set(patch, { merge: true });
    return { ...current, ...patch };
  }

  async listMediaGenerationTasks(jobId) {
    const snap = await this.db.collection('media_generation_tasks').where('job_id', '==', jobId).get();
    return snap.docs.map(d => d.data());
  }

  // 8. Production Scenes
  async replaceProductionScenes(productionId, scenes = []) {
    const scenesCol = this.db.collection('productions').doc(productionId).collection('scenes');
    const oldSnap = await scenesCol.get();
    const batch = this.db.batch();
    oldSnap.docs.forEach(doc => batch.delete(doc.ref));

    for (const [index, scene] of scenes.entries()) {
      const position = Number(scene.position !== undefined ? scene.position : index);
      const sceneId = scene.id || this.generateId('scene');
      const docRef = scenesCol.doc(String(position));
      batch.set(docRef, {
        id: sceneId,
        production_id: productionId,
        position,
        label: scene.label || `Scene ${position + 1}`,
        script_text: scene.scriptText || scene.script_text || '',
        prompt: scene.prompt || '',
        duration: Number(scene.duration || 5),
        asset_type: scene.assetType || scene.asset_type || 'missing',
        asset_origin: scene.assetOrigin || scene.asset_origin || 'generated',
        asset_path: scene.assetPath || scene.asset_path || null,
        audio_path: scene.audioPath || scene.audio_path || null,
        narration_provider: scene.narrationProvider || null,
        narration_model: scene.narrationModel || null,
        narration_task_id: scene.narrationTaskId || null,
        narration_error: scene.narrationError || null,
        narration_generated_at: scene.narrationGeneratedAt || null,
        narration_cost: scene.narrationCost || {},
        provider: scene.provider || null,
        model: scene.model || null,
        external_task_id: scene.externalTaskId || null,
        status: scene.status || 'ready',
        narration_status: scene.narrationStatus || 'current',
        revision: Number(scene.revision || 1),
        locked: scene.locked ? 1 : 0,
        rights_confirmed: scene.rightsConfirmed ? 1 : 0,
        provenance_source_ids: scene.provenanceSourceIds || [],
        contains_synthetic_media: scene.containsSyntheticMedia ? 1 : 0,
        estimated_cost: scene.estimatedCost || {},
        actual_cost: scene.actualCost || {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
    await batch.commit();
    return this.listProductionScenes(productionId);
  }

  async listProductionScenes(productionId) {
    const snap = await this.db.collection('productions').doc(productionId).collection('scenes').orderBy('position', 'asc').get();
    return snap.docs.map(doc => {
      const row = doc.data();
      return {
        ...row,
        productionId: row.production_id,
        scriptText: row.script_text,
        assetType: row.asset_type,
        assetOrigin: row.asset_origin,
        assetPath: row.asset_path,
        audioPath: row.audio_path,
        narrationProvider: row.narration_provider,
        narrationModel: row.narration_model,
        narrationTaskId: row.narration_task_id,
        narrationError: row.narration_error,
        narrationGeneratedAt: row.narration_generated_at,
        narrationCost: row.narration_cost || {},
        narrationStatus: row.narration_status,
        externalTaskId: row.external_task_id,
        provenanceSourceIds: row.provenance_source_ids || [],
        containsSyntheticMedia: Boolean(row.contains_synthetic_media),
        rightsConfirmed: Boolean(row.rights_confirmed),
        locked: Boolean(row.locked),
        estimatedCost: row.estimated_cost || {},
        actualCost: row.actual_cost || {}
      };
    });
  }

  async getProductionScene(productionId, sceneId) {
    const scenes = await this.listProductionScenes(productionId);
    return scenes.find(s => s.id === sceneId || String(s.position) === String(sceneId)) || null;
  }

  async updateProductionScene(productionId, sceneId, changes = {}) {
    const scene = await this.getProductionScene(productionId, sceneId);
    if (!scene) return null;
    const docRef = this.db.collection('productions').doc(productionId).collection('scenes').doc(String(scene.position));
    await docRef.set({ ...changes, updated_at: new Date().toISOString() }, { merge: true });
    return this.getProductionScene(productionId, scene.id);
  }

  async reorderProductionScenes(productionId, orderedIds = []) {
    const scenes = await this.listProductionScenes(productionId);
    const sceneMap = new Map(scenes.map(s => [s.id, s]));
    const reordered = orderedIds.map((id, index) => {
      const s = sceneMap.get(id);
      return s ? { ...s, position: index } : null;
    }).filter(Boolean);
    return this.replaceProductionScenes(productionId, reordered);
  }

  async saveProductionSceneRevision(input = {}) {
    const id = this.generateId('revision');
    const docRef = this.db.collection('productions').doc(input.productionId).collection('scene_revisions').doc(id);
    const data = {
      id,
      production_id: input.productionId,
      scene_id: input.sceneId,
      action: input.action,
      status: input.status || 'completed',
      before_state: input.beforeState || {},
      after_state: input.afterState || {},
      cost_evidence: input.costEvidence || {},
      error: input.error || null,
      created_at: new Date().toISOString()
    };
    await docRef.set(data);
    return data;
  }

  async getProductionSceneRevision(id) {
    const snap = await this.db.collectionGroup('scene_revisions').where('id', '==', id).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }

  async listProductionSceneRevisions(productionId, limit = 100) {
    const snap = await this.db.collection('productions').doc(productionId).collection('scene_revisions').limit(limit).get();
    return snap.docs.map(d => d.data());
  }

  // 9. Shorts Clips
  async replaceShortClips(productionId, clips = []) {
    const shortsCol = this.db.collection('productions').doc(productionId).collection('shorts');
    const oldSnap = await shortsCol.get();
    const batch = this.db.batch();
    oldSnap.docs.forEach(doc => batch.delete(doc.ref));

    for (const [index, clip] of clips.entries()) {
      const position = Number(clip.position !== undefined ? clip.position : index);
      const id = clip.id || this.generateId('short');
      const docRef = shortsCol.doc(String(position));
      batch.set(docRef, {
        id,
        production_id: productionId,
        position,
        title: clip.title,
        description: clip.description || '',
        tags: clip.tags || [],
        source_scene_ids: clip.sourceSceneIds || [],
        start_seconds: Number(clip.startSeconds || 0),
        duration: Number(clip.duration || 30),
        layout: clip.layout || 'blur',
        rationale: clip.rationale || null,
        status: clip.status || 'proposed',
        output_path: clip.outputPath || null,
        captions_path: clip.captionsPath || null,
        publish_time: clip.publishTime || null,
        privacy_status: clip.privacyStatus || 'private',
        inherited_evidence: clip.inheritedEvidence || {},
        schedule_id: clip.scheduleId || null,
        youtube_id: clip.youtubeId || null,
        youtube_url: clip.youtubeUrl || null,
        error: clip.error || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }
    await batch.commit();
    return this.listShortClips(productionId);
  }

  async listShortClips(productionId) {
    const snap = await this.db.collection('productions').doc(productionId).collection('shorts').orderBy('position', 'asc').get();
    return snap.docs.map(doc => {
      const row = doc.data();
      return {
        ...row,
        productionId: row.production_id,
        sourceSceneIds: row.source_scene_ids || [],
        tags: row.tags || [],
        inheritedEvidence: row.inherited_evidence || {}
      };
    });
  }

  async getShortClip(id) {
    const snap = await this.db.collectionGroup('shorts').where('id', '==', id).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }

  async updateShortClip(id, changes = {}) {
    const snap = await this.db.collectionGroup('shorts').where('id', '==', id).limit(1).get();
    if (snap.empty) return null;
    const docRef = snap.docs[0].ref;
    await docRef.set({ ...changes, updated_at: new Date().toISOString() }, { merge: true });
    return this.getShortClip(id);
  }

  async markInterruptedJobs() {
    const snap = await this.db.collection('generation_jobs').where('status', 'in', ['running', 'processing']).get();
    const batch = this.db.batch();
    snap.docs.forEach(doc => {
      batch.update(doc.ref, {
        status: 'interrupted',
        error: 'Job was interrupted by a system restart',
        updated_at: new Date().toISOString()
      });
    });
    await batch.commit();
  }

  // 10. Reviews & Provenance
  async saveContentReview(productionId, review = {}) {
    const docRef = this.db.collection('content_reviews').doc(productionId);
    const data = {
      production_id: productionId,
      status: review.status || 'needs_review',
      editor_data: review.editorData || {},
      quality_checks: review.qualityChecks || [],
      review_notes: review.reviewNotes || null,
      reviewed_at: review.reviewedAt || null,
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return this.getProductionBundle(productionId);
  }

  async saveContentProvenance(productionId, provenance = {}) {
    const docRef = this.db.collection('content_provenance').doc(productionId);
    const data = {
      production_id: productionId,
      sources: provenance.sources || [],
      claims: provenance.claims || [],
      contains_synthetic_media: Boolean(provenance.containsSyntheticMedia),
      status: provenance.status || 'not_required',
      summary: provenance.summary || {},
      reviewed_at: provenance.reviewedAt || null,
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return this.getContentProvenance(productionId);
  }

  async getContentProvenance(productionId) {
    const doc = await this.db.collection('content_provenance').doc(productionId).get();
    return doc.exists ? doc.data() : null;
  }

  // 11. Discoverability
  async saveDiscoverabilityAudit(productionId, platform, report = {}) {
    const auditId = this.generateId('discoverability');
    const auditRef = this.db.collection('discoverability_audits').doc(auditId);
    await auditRef.set({
      id: auditId,
      production_id: productionId,
      platform: platform || 'youtube',
      mode: report.mode || 'content',
      engine: report.engine?.name || 'darkzseo',
      engine_version: report.engine?.version || null,
      schema_version: report.schemaVersion || null,
      status: report.status || 'unavailable',
      summary: report.summary || {},
      error_code: report.errorCode || null,
      error: report.error || null,
      created_at: new Date().toISOString()
    });

    const findings = Array.isArray(report.findings) ? report.findings : [];
    const batch = this.db.batch();
    for (const finding of findings) {
      const findingId = this.generateId('finding');
      const findingRef = auditRef.collection('findings').doc(findingId);
      batch.set(findingRef, {
        id: findingId,
        audit_id: auditId,
        rule_id: finding.ruleId,
        category: finding.category,
        severity: finding.severity,
        applicability: finding.applicability || [],
        message: finding.message,
        remediation: finding.remediation || null,
        fingerprint: finding.fingerprint,
        review_status: 'pending',
        created_at: new Date().toISOString()
      });
    }
    await batch.commit();
    return this.getDiscoverabilityAudit(auditId);
  }

  async getDiscoverabilityAudit(auditId) {
    const doc = await this.db.collection('discoverability_audits').doc(auditId).get();
    if (!doc.exists) return null;
    const snap = await doc.ref.collection('findings').get();
    const findings = snap.docs.map(d => d.data());
    return { ...doc.data(), findings };
  }

  async getLatestDiscoverabilityAudit(productionId, platform = 'youtube') {
    const snap = await this.db.collection('discoverability_audits')
      .where('production_id', '==', productionId)
      .where('platform', '==', platform)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return this.getDiscoverabilityAudit(snap.docs[0].id);
  }

  async getDiscoverabilityFinding(findingId) {
    const snap = await this.db.collectionGroup('findings').where('id', '==', findingId).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }

  async reviewDiscoverabilityFinding(findingId, status, reason) {
    const snap = await this.db.collectionGroup('findings').where('id', '==', findingId).limit(1).get();
    if (snap.empty) return null;
    await snap.docs[0].ref.update({
      review_status: status,
      review_reason: reason || null,
      reviewed_at: new Date().toISOString()
    });
    return this.getDiscoverabilityFinding(findingId);
  }

  // 12. Channel Profiles
  async getChannelProfile() {
    const doc = await this.db.collection('channel_profiles').doc('default').get();
    return doc.exists ? doc.data() : null;
  }

  async saveChannelProfile(profile) {
    const docRef = this.db.collection('channel_profiles').doc('default');
    const current = (await docRef.get()).data() || {};
    const data = {
      id: 'default',
      channel_name: profile.channelName ?? profile.channel_name ?? current.channel_name ?? '',
      goal: profile.goal ?? current.goal ?? '',
      target_audience: profile.targetAudience ?? profile.target_audience ?? current.target_audience ?? '',
      brand_voice: profile.brandVoice ?? profile.brand_voice ?? current.brand_voice ?? '',
      default_style: profile.defaultStyle ?? profile.default_style ?? current.default_style ?? 'explainer',
      call_to_action: profile.callToAction ?? profile.call_to_action ?? current.call_to_action ?? '',
      banned_topics: profile.bannedTopics ?? profile.banned_topics ?? current.banned_topics ?? [],
      visual_style: profile.visualStyle ?? profile.visual_style ?? current.visual_style ?? '',
      timezone: profile.timezone ?? current.timezone ?? 'Asia/Kolkata',
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return this.getChannelProfile();
  }

  // 13. Content Ideas
  async createContentIdea(idea) {
    const id = this.generateId('idea');
    const docRef = this.db.collection('content_ideas').doc(id);
    const data = {
      id,
      topic: idea.topic,
      angle: idea.angle || null,
      style: idea.style || 'explainer',
      status: idea.status || 'backlog',
      rationale: idea.rationale || null,
      scheduled_for: idea.scheduledFor || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await docRef.set(data);
    return data;
  }

  async listContentIdeas() {
    const snap = await this.db.collection('content_ideas').get();
    return snap.docs.map(d => d.data());
  }

  async updateContentIdea(id, changes) {
    const docRef = this.db.collection('content_ideas').doc(id);
    await docRef.set({ ...changes, updated_at: new Date().toISOString() }, { merge: true });
    return (await docRef.get()).data();
  }

  // 14. Story Universes & Episodes
  async saveStoryUniverse(universe) {
    const id = universe.id || this.generateId('universe');
    const docRef = this.db.collection('story_universes').doc(id);
    const data = {
      id,
      title: universe.title,
      premise: universe.premise,
      genre: universe.genre || 'what_if_fiction',
      status: universe.status || 'active',
      characters: universe.characters || [],
      locations: universe.locations || [],
      rules: universe.rules || [],
      episode_count: Number(universe.episodeCount || universe.episode_count || 0),
      timeline_events: universe.timelineEvents || universe.timeline_events || [],
      audience_demand_score: Number(universe.audienceDemandScore || universe.audience_demand_score || 0),
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return this.getStoryUniverse(id);
  }

  async getStoryUniverse(id) {
    const doc = await this.db.collection('story_universes').doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  async listStoryUniverses(status = 'active') {
    let query = this.db.collection('story_universes');
    if (status) query = query.where('status', '==', status);
    const snap = await query.get();
    return snap.docs.map(d => d.data());
  }

  async saveStoryEpisode(episode) {
    const id = episode.id || this.generateId('episode');
    const universeId = episode.universeId || episode.universe_id;
    const docRef = this.db.collection('story_universes').doc(universeId).collection('episodes').doc(id);
    const data = {
      id,
      universe_id: universeId,
      episode_number: Number(episode.episodeNumber || episode.episode_number),
      title: episode.title,
      summary: episode.summary,
      key_events: episode.keyEvents || episode.key_events || [],
      cliffhanger: episode.cliffhanger || null,
      character_arcs: episode.characterArcs || episode.character_arcs || {},
      status: episode.status || 'planned',
      production_id: episode.productionId || episode.production_id || null,
      video_id: episode.videoId || episode.video_id || null,
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return data;
  }

  async listStoryEpisodes(universeId) {
    const snap = await this.db.collection('story_universes').doc(universeId).collection('episodes').orderBy('episode_number', 'asc').get();
    return snap.docs.map(d => d.data());
  }

  // 15. Monetization Evaluations
  async saveMonetizationEvaluation(evaluation) {
    const id = evaluation.id || this.generateId('moneval');
    const docRef = this.db.collection('monetization_evaluations').doc(id);
    const data = {
      id,
      production_id: evaluation.productionId || evaluation.production_id || null,
      video_id: evaluation.videoId || evaluation.video_id || null,
      originality_score: Number(evaluation.originalityScore ?? evaluation.originality_score ?? 1.0),
      reused_content_risk: evaluation.reusedContentRisk || evaluation.reused_content_risk || 'low',
      policy_checks: evaluation.policyChecks || evaluation.policy_checks || {},
      copyright_attribution: evaluation.copyrightAttribution || evaluation.copyright_attribution || [],
      subscribers_snapshot: evaluation.subscribersSnapshot ?? evaluation.subscribers_snapshot ?? null,
      watch_hours_snapshot: evaluation.watchHoursSnapshot ?? evaluation.watch_hours_snapshot ?? null,
      monetization_ready: evaluation.monetizationReady ?? evaluation.monetization_ready ? 1 : 0,
      recommendations: evaluation.recommendations || [],
      evaluated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return data;
  }

  async getLatestMonetizationEvaluation() {
    const snap = await this.db.collection('monetization_evaluations').orderBy('evaluated_at', 'desc').limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }

  // 16. Channel Strategy & Operator Runs
  async getChannelStrategy() {
    const doc = await this.db.collection('channel_strategies').doc('default').get();
    return doc.exists ? doc.data() : null;
  }

  async saveChannelStrategy(strategy) {
    const docRef = this.db.collection('channel_strategies').doc('default');
    const current = (await docRef.get()).data() || {};
    const data = {
      id: 'default',
      objective: strategy.objective ?? current.objective ?? '',
      audience: strategy.audience ?? current.audience ?? '',
      value_proposition: strategy.valueProposition ?? strategy.value_proposition ?? current.value_proposition ?? '',
      content_pillars: strategy.contentPillars ?? strategy.content_pillars ?? current.content_pillars ?? [],
      cadence_per_week: strategy.cadencePerWeek ?? strategy.cadence_per_week ?? current.cadence_per_week ?? 7,
      videos_per_run: strategy.videosPerRun ?? strategy.videos_per_run ?? current.videos_per_run ?? 1,
      default_format: strategy.defaultFormat ?? strategy.default_format ?? current.default_format ?? 'story',
      default_length: strategy.defaultLength ?? strategy.default_length ?? current.default_length ?? '8-12 minutes',
      success_metric: strategy.successMetric ?? strategy.success_metric ?? current.success_metric ?? '',
      primary_kpi: strategy.primaryKpi ?? strategy.primary_kpi ?? current.primary_kpi ?? 'views',
      target_value: strategy.targetValue ?? strategy.target_value ?? current.target_value ?? null,
      target_window_days: strategy.targetWindowDays ?? strategy.target_window_days ?? current.target_window_days ?? 28,
      monthly_budget: strategy.monthlyBudget ?? strategy.monthly_budget ?? current.monthly_budget ?? null,
      outcome_currency: strategy.outcomeCurrency ?? strategy.outcome_currency ?? current.outcome_currency ?? 'INR',
      constraints: strategy.constraints ?? current.constraints ?? '',
      status: strategy.status ?? current.status ?? 'draft',
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return this.getChannelStrategy();
  }

  async createOperatorRun(strategyId = 'default') {
    const id = this.generateId('operator');
    const docRef = this.db.collection('operator_runs').doc(id);
    const data = {
      id,
      strategy_id: strategyId,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      research: {},
      plan: [],
      generated_jobs: [],
      summary: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await docRef.set(data);
    return data;
  }

  async getOperatorRun(id) {
    const doc = await this.db.collection('operator_runs').doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  async getActiveOperatorRun() {
    const snap = await this.db.collection('operator_runs')
      .where('status', 'in', ['queued', 'running', 'cancelling'])
      .limit(1)
      .get();
    return snap.empty ? null : snap.docs[0].data();
  }

  async listOperatorRuns(limit = 10) {
    const snap = await this.db.collection('operator_runs').limit(limit).get();
    return snap.docs.map(d => d.data());
  }

  async updateOperatorRun(id, changes = {}) {
    const docRef = this.db.collection('operator_runs').doc(id);
    await docRef.set({ ...changes, updated_at: new Date().toISOString() }, { merge: true });
    return (await docRef.get()).data();
  }

  // 17. Notifications & Automation Events
  async createNotification(notification) {
    const id = this.generateId('notice');
    const docRef = this.db.collection('notifications').doc(id);
    const data = {
      id,
      type: notification.type || 'system',
      level: notification.level || 'info',
      title: notification.title,
      message: notification.message,
      data: notification.data || {},
      status: 'unread',
      created_at: new Date().toISOString()
    };
    await docRef.set(data);
    return id;
  }

  async listNotifications(limit = 20) {
    const snap = await this.db.collection('notifications').limit(limit).get();
    return snap.docs.map(d => d.data());
  }

  async markNotificationRead(id) {
    await this.db.collection('notifications').doc(id).update({ status: 'read' });
  }

  async getRecentAutomationEvents(limit = 30) {
    const snap = await this.db.collection('automation_events').limit(limit).get();
    return snap.docs.map(d => d.data());
  }

  // 18. Publishing Schedule & Transactional Locks
  async saveScheduleEntry(entry) {
    const existing = await this.getLatestScheduleEntry(entry.productionId);
    if (existing) return existing;
    const id = this.generateId('schedule');
    entry.id = id;
    const docRef = this.db.collection('publish_schedule').doc(id);
    const data = {
      id,
      production_id: entry.productionId,
      title: entry.title,
      publish_time: entry.publishTime || entry.publish_time,
      status: entry.status || 'scheduled',
      priority: entry.priority || 50,
      metadata: entry.metadata || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await docRef.set(data);
    return entry;
  }

  async updateScheduleEntry(entry) {
    const docRef = this.db.collection('publish_schedule').doc(entry.id);
    await docRef.set({
      ...entry,
      updated_at: new Date().toISOString()
    }, { merge: true });
  }

  async deleteScheduleEntry(id) {
    await this.db.collection('publish_schedule').doc(id).delete();
  }

  async getLatestScheduleEntry(productionId) {
    const snap = await this.db.collection('publish_schedule').where('production_id', '==', productionId).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }

  async getUpcomingSchedule(_days = 7) {
    const snap = await this.db.collection('publish_schedule').where('status', '==', 'scheduled').get();
    return snap.docs.map(d => d.data());
  }

  // Transactional Publishing Lock: Prevents double uploads across concurrent runners
  async acquirePublishingLock(scheduleId) {
    const docRef = this.db.collection('publish_schedule').doc(scheduleId);
    return this.db.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (!doc.exists) {
        throw new Error(`Schedule entry ${scheduleId} not found`);
      }
      const data = doc.data();
      if (data.status === 'published') {
        return { locked: false, reason: 'ALREADY_PUBLISHED', entry: data };
      }
      if (data.status === 'uploading' || data.status === 'reconciliation_required') {
        return { locked: false, reason: 'RECONCILIATION_REQUIRED', entry: data };
      }
      transaction.update(docRef, {
        status: 'uploading',
        upload_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      return { locked: true, entry: { ...data, status: 'uploading' } };
    });
  }

  // 19. Analytics & Retention Snapshots
  async saveAnalyticsReport(report) {
    const id = this.generateId('analytics');
    const docRef = this.db.collection('analytics_reports').doc(id);
    const data = {
      id,
      video_id: report.videoId,
      youtube_id: report.youtubeId || null,
      video_details: report.videoDetails || {},
      analytics_data: report.analytics || {},
      thumbnail_metrics: report.thumbnailMetrics || {},
      seo_metrics: report.seoMetrics || {},
      insights: report.insights || [],
      performance_score: report.performance?.score || 0,
      performance_grade: report.performance?.grade || 'C',
      analyzed_at: new Date().toISOString()
    };
    await docRef.set(data);
    return id;
  }

  async getAnalyticsHistory() {
    const snap = await this.db.collection('analytics_reports').get();
    return snap.docs.map(d => d.data());
  }

  async savePerformanceSnapshot(snapshot) {
    const docId = `${snapshot.videoId}_${snapshot.measurementWindow}`;
    const docRef = this.db.collection('performance_snapshots').doc(docId);
    const data = {
      id: docId,
      video_id: snapshot.videoId,
      production_id: snapshot.productionId || null,
      measurement_window: snapshot.measurementWindow,
      published_at: snapshot.publishedAt || null,
      metrics: snapshot.metrics || {},
      content_attributes: snapshot.contentAttributes || {},
      baseline: snapshot.baseline || {},
      deltas: snapshot.deltas || {},
      confidence: snapshot.confidence || 'low',
      simulated: snapshot.simulated ? 1 : 0,
      measured_at: snapshot.measuredAt || new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return data;
  }

  async getPerformanceSnapshot(id) {
    const doc = await this.db.collection('performance_snapshots').doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  async listPerformanceSnapshots(options = {}) {
    let query = this.db.collection('performance_snapshots');
    if (options.videoId) query = query.where('video_id', '==', options.videoId);
    if (options.measurementWindow) query = query.where('measurement_window', '==', options.measurementWindow);
    const snap = await query.get();
    return snap.docs.map(d => d.data());
  }

  async saveRetentionSnapshot(snapshot) {
    const docId = `${snapshot.videoId}_${snapshot.measurementWindow}`;
    const docRef = this.db.collection('retention_snapshots').doc(docId);
    const data = {
      id: docId,
      video_id: snapshot.videoId,
      production_id: snapshot.productionId || null,
      short_clip_id: snapshot.shortClipId || null,
      title: snapshot.title || null,
      surface: snapshot.surface || 'long_form',
      measurement_window: snapshot.measurementWindow,
      published_at: snapshot.publishedAt || null,
      duration_seconds: Number(snapshot.durationSeconds || 0),
      points: snapshot.points || [],
      scene_metrics: snapshot.sceneMetrics || [],
      summary: snapshot.summary || {},
      confidence: snapshot.confidence || 'low',
      measured_at: snapshot.measuredAt || new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return data;
  }

  async getRetentionSnapshot(id) {
    const doc = await this.db.collection('retention_snapshots').doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  async listRetentionSnapshots(options = {}) {
    let query = this.db.collection('retention_snapshots');
    if (options.videoId) query = query.where('video_id', '==', options.videoId);
    if (options.surface) query = query.where('surface', '==', options.surface);
    const snap = await query.get();
    return snap.docs.map(d => d.data());
  }

  // 20. Learning & Experiments
  async saveLearningRecommendation(rec) {
    const docId = rec.fingerprint || this.generateId('learning');
    const docRef = this.db.collection('learning_recommendations').doc(docId);
    const data = {
      id: docId,
      fingerprint: rec.fingerprint,
      category: rec.category,
      title: rec.title,
      rationale: rec.rationale,
      evidence: rec.evidence || {},
      proposed_change: rec.proposedChange || rec.proposed_change || {},
      confidence: rec.confidence || 'low',
      status: rec.status || 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return data;
  }

  async getLearningRecommendation(id) {
    const doc = await this.db.collection('learning_recommendations').doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  async listLearningRecommendations(options = {}) {
    let query = this.db.collection('learning_recommendations');
    if (options.status) query = query.where('status', '==', options.status);
    const snap = await query.get();
    return snap.docs.map(d => d.data());
  }

  async reviewLearningRecommendation(id, status) {
    const docRef = this.db.collection('learning_recommendations').doc(id);
    await docRef.update({
      status,
      reviewed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    return (await docRef.get()).data();
  }

  async createGrowthExperiment(experiment, arms = []) {
    const id = experiment.id || this.generateId('experiment');
    const expRef = this.db.collection('growth_experiments').doc(id);
    const expData = {
      id,
      production_id: experiment.productionId,
      video_id: experiment.videoId,
      recommendation_id: experiment.recommendationId || null,
      title: experiment.title,
      hypothesis: experiment.hypothesis,
      primary_metric: experiment.primaryMetric || 'ctr',
      status: experiment.status || 'draft',
      arm_duration_hours: experiment.armDurationHours || 48,
      min_impressions: experiment.minImpressions || 1000,
      guardrails: experiment.guardrails || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    await expRef.set(expData);

    const batch = this.db.batch();
    for (const [index, arm] of arms.entries()) {
      const armId = arm.id || this.generateId('arm');
      const armRef = expRef.collection('arms').doc(armId);
      batch.set(armRef, {
        id: armId,
        experiment_id: id,
        arm_index: index,
        label: arm.label,
        title: arm.title,
        thumbnail_path: arm.thumbnailPath,
        is_control: arm.isControl ? 1 : 0,
        baseline_metrics: {},
        final_metrics: {},
        created_at: new Date().toISOString()
      });
    }
    await batch.commit();
    return this.getGrowthExperiment(id);
  }

  async getGrowthExperiment(id) {
    const doc = await this.db.collection('growth_experiments').doc(id).get();
    if (!doc.exists) return null;
    const armsSnap = await doc.ref.collection('arms').orderBy('arm_index', 'asc').get();
    const arms = armsSnap.docs.map(d => d.data());
    return { ...doc.data(), arms };
  }

  async listGrowthExperiments(options = {}) {
    let query = this.db.collection('growth_experiments');
    if (options.productionId) query = query.where('production_id', '==', options.productionId);
    const snap = await query.get();
    return Promise.all(snap.docs.map(d => this.getGrowthExperiment(d.id)));
  }

  async updateGrowthExperiment(id, changes = {}) {
    const docRef = this.db.collection('growth_experiments').doc(id);
    await docRef.set({ ...changes, updated_at: new Date().toISOString() }, { merge: true });
    return this.getGrowthExperiment(id);
  }

  async updateExperimentArm(id, changes = {}) {
    const snap = await this.db.collectionGroup('arms').where('id', '==', id).limit(1).get();
    if (snap.empty) return null;
    const ref = snap.docs[0].ref;
    await ref.set({ ...changes, updated_at: new Date().toISOString() }, { merge: true });
    return (await ref.get()).data();
  }

  async saveExperimentSample(sample) {
    const id = this.generateId('sample');
    const docRef = this.db.collection('growth_experiments').doc(sample.experimentId).collection('arms').doc(sample.armId).collection('samples').doc(id);
    const data = {
      id,
      experiment_id: sample.experimentId,
      arm_id: sample.armId,
      metrics: sample.metrics || {},
      traffic_sources: sample.trafficSources || [],
      captured_at: sample.capturedAt || new Date().toISOString()
    };
    await docRef.set(data);
    return id;
  }

  async listExperimentSamples(experimentId, limit = 250) {
    const snap = await this.db.collectionGroup('samples').where('experiment_id', '==', experimentId).limit(limit).get();
    return snap.docs.map(d => d.data());
  }

  // 21. Audience Comments & Reply Drafts
  async upsertAudienceComment(comment) {
    const docRef = this.db.collection('audience_comments').doc(comment.commentId);
    const doc = await docRef.get();
    const id = doc.exists ? doc.data().id : this.generateId('comment');
    const data = {
      id,
      comment_id: comment.commentId,
      video_id: comment.videoId,
      parent_comment_id: comment.parentCommentId || null,
      author_name: comment.authorName || null,
      author_channel_id: comment.authorChannelId || null,
      is_channel_owner: comment.isChannelOwner ? 1 : 0,
      text: comment.text,
      like_count: Number(comment.likeCount || 0),
      reply_count: Number(comment.replyCount || 0),
      published_at: comment.publishedAt || null,
      updated_at_youtube: comment.updatedAtYouTube || null,
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return this.getAudienceComment(comment.commentId);
  }

  async getAudienceComment(commentId) {
    const doc = await this.db.collection('audience_comments').doc(commentId).get();
    return doc.exists ? doc.data() : null;
  }

  async listAudienceComments(options = {}) {
    let query = this.db.collection('audience_comments').where('video_id', '==', options.videoId);
    if (options.topLevelOnly) query = query.where('parent_comment_id', '==', null);
    const snap = await query.limit(options.limit || 200).get();
    return snap.docs.map(d => d.data());
  }

  async countAudienceComments(videoId) {
    const snap = await this.db.collection('audience_comments').where('video_id', '==', videoId).get();
    const total = snap.size;
    const topLevel = snap.docs.filter(d => !d.data().parent_comment_id).length;
    return { total, topLevel };
  }

  async setAudienceCommentAnalysis(commentId, flags) {
    const docRef = this.db.collection('audience_comments').doc(commentId);
    await docRef.update({
      flags: flags || [],
      analysis_state: 'analyzed',
      updated_at: new Date().toISOString()
    });
    return this.getAudienceComment(commentId);
  }

  async markAudienceCommentReplied(commentId) {
    const docRef = this.db.collection('audience_comments').doc(commentId);
    await docRef.update({
      replied_by_agent: 1,
      updated_at: new Date().toISOString()
    });
    return this.getAudienceComment(commentId);
  }

  async saveEngagementInsight(insight) {
    const docRef = this.db.collection('engagement_insights').doc(insight.videoId);
    const data = {
      id: insight.videoId,
      video_id: insight.videoId,
      production_id: insight.productionId || null,
      title: insight.title || null,
      comment_count: Number(insight.commentCount || 0),
      analyzed_count: Number(insight.analyzedCount || 0),
      sentiment: insight.sentiment || {},
      themes: insight.themes || [],
      attention_flags: insight.attentionFlags || [],
      analysis_method: insight.analysisMethod || 'ai',
      analyzed_at: insight.analyzedAt || null,
      last_synced_at: insight.lastSyncedAt || null,
      newest_comment_at: insight.newestCommentAt || null,
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return data;
  }

  async getEngagementInsight(videoId) {
    const doc = await this.db.collection('engagement_insights').doc(videoId).get();
    return doc.exists ? doc.data() : null;
  }

  async listEngagementInsights(options = {}) {
    const snap = await this.db.collection('engagement_insights').limit(options.limit || 12).get();
    return snap.docs.map(d => d.data());
  }

  async saveReplyDraft(draft) {
    const docRef = this.db.collection('reply_drafts').doc(draft.commentId);
    const current = (await docRef.get()).data();
    if (current?.status === 'posted') {
      const error = new Error('A posted reply cannot be replaced');
      error.status = 409;
      throw error;
    }
    const data = {
      id: current?.id || this.generateId('reply'),
      comment_id: draft.commentId,
      video_id: draft.videoId,
      draft_text: draft.draftText,
      rationale: draft.rationale || null,
      edited_text: null,
      status: 'proposed',
      posted_comment_id: null,
      posted_at: null,
      failure_reason: null,
      updated_at: new Date().toISOString()
    };
    await docRef.set(data, { merge: true });
    return data;
  }

  async getReplyDraft(id) {
    const snap = await this.db.collection('reply_drafts').where('id', '==', id).limit(1).get();
    if (!snap.empty) return snap.docs[0].data();
    const doc = await this.db.collection('reply_drafts').doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  async listReplyDrafts(options = {}) {
    let query = this.db.collection('reply_drafts');
    if (options.videoId) query = query.where('video_id', '==', options.videoId);
    if (options.status) query = query.where('status', '==', options.status);
    const snap = await query.limit(options.limit || 50).get();
    return snap.docs.map(d => d.data());
  }

  async updateReplyDraft(id, changes = {}) {
    const draft = await this.getReplyDraft(id);
    if (!draft) return null;
    const docRef = this.db.collection('reply_drafts').doc(draft.comment_id || id);
    await docRef.set({ ...changes, updated_at: new Date().toISOString() }, { merge: true });
    return (await docRef.get()).data();
  }

  async countReplyDraftsPostedSince(isoTime) {
    const snap = await this.db.collection('reply_drafts')
      .where('status', '==', 'posted')
      .where('posted_at', '>=', isoTime)
      .get();
    return snap.size;
  }

  // 22. Keyword Performance
  async updateKeywordPerformance(keyword, views, videoId) {
    const docRef = this.db.collection('keyword_performance').doc(keyword);
    const doc = await docRef.get();
    if (doc.exists) {
      const current = doc.data();
      const totalUses = (current.total_uses || 0) + 1;
      const totalViews = (current.total_views || 0) + views;
      const avgViews = Math.round(totalViews / totalUses);
      await docRef.update({
        total_uses: totalUses,
        total_views: totalViews,
        average_views: avgViews,
        best_performing_video: views > (current.total_views / (current.total_uses || 1)) ? videoId : current.best_performing_video,
        last_used: new Date().toISOString()
      });
    } else {
      await docRef.set({
        id: keyword,
        keyword,
        total_uses: 1,
        total_views: views,
        average_views: views,
        best_performing_video: videoId,
        last_used: new Date().toISOString(),
        performance_score: Math.min(100, Math.round(views / 1000))
      });
    }
  }

  async getKeywordHistory() {
    const snap = await this.db.collection('keyword_performance').get();
    return snap.docs.map(d => d.data());
  }

  // 23. Settings
  async getSetting(key) {
    const doc = await this.db.collection('settings').doc(key).get();
    return doc.exists ? doc.data().value : null;
  }

  async setSetting(key, value, description = null) {
    const docRef = this.db.collection('settings').doc(key);
    const current = (await docRef.get()).data();
    await docRef.set({
      key,
      value: String(value),
      description: description || current?.description || null,
      updated_at: new Date().toISOString()
    }, { merge: true });
  }

  async getAllSettings() {
    const snap = await this.db.collection('settings').get();
    return snap.docs.reduce((acc, d) => {
      acc[d.id] = d.data().value;
      return acc;
    }, {});
  }

  // 24. Readiness Runs
  async saveReadinessRun(run) {
    const docRef = this.db.collection('readiness_runs').doc(run.id);
    const data = {
      id: run.id,
      status: run.status,
      checks: run.checks || [],
      summary: run.summary || {},
      started_at: run.startedAt,
      completed_at: run.completedAt,
      created_at: new Date().toISOString()
    };
    await docRef.set(data);
    return data;
  }

  async getReadinessRun(id) {
    const doc = await this.db.collection('readiness_runs').doc(id).get();
    return doc.exists ? doc.data() : null;
  }

  async getLatestReadinessRun() {
    const snap = await this.db.collection('readiness_runs').orderBy('completed_at', 'desc').limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }

  async getStats() {
    const [stratSnap, scriptsSnap, prodSnap, schedSnap, reportSnap] = await Promise.all([
      this.db.collection('content_strategies').count().get(),
      this.db.collection('scripts').count().get(),
      this.db.collection('productions').count().get(),
      this.db.collection('publish_schedule').where('status', '==', 'published').count().get(),
      this.db.collection('analytics_reports').count().get()
    ]);
    return {
      strategies: stratSnap.data().count,
      scripts: scriptsSnap.data().count,
      productions: prodSnap.data().count,
      published: schedSnap.data().count,
      analytics: reportSnap.data().count,
      dbSize: 'Cloud Firestore'
    };
  }

  async exportStateJSON() {
    const ALLOWED_TABLES = [
      'channel_profiles', 'channel_strategies', 'settings', 'story_universes',
      'story_episodes', 'monetization_evaluations', 'publish_schedule', 'content_ideas',
      'performance_snapshots', 'retention_snapshots', 'audience_comments', 'engagement_insights',
      'production_scenes', 'production_scene_revisions'
    ];
    const state = {};
    for (const table of ALLOWED_TABLES) {
      try {
        const snap = await this.db.collection(table).get();
        let rows = snap.docs.map(doc => doc.data());
        if (table === 'settings' && Array.isArray(rows)) {
          const sensitivePattern = /key|token|secret|pass|auth|credential/i;
          rows = rows.filter(r => !sensitivePattern.test(String(r.key || '')));
        }
        state[table] = rows;
      } catch (_e) {
        state[table] = [];
      }
    }
    return state;
  }

  async importStateJSON(state = {}) {
    if (!state || typeof state !== 'object') return false;
    const ALLOWED_TABLES = new Set([
      'channel_profiles', 'channel_strategies', 'settings', 'story_universes',
      'story_episodes', 'monetization_evaluations', 'publish_schedule', 'content_ideas',
      'performance_snapshots', 'retention_snapshots', 'audience_comments', 'engagement_insights',
      'production_scenes', 'production_scene_revisions'
    ]);

    for (const [table, rows] of Object.entries(state)) {
      if (!ALLOWED_TABLES.has(table) || !Array.isArray(rows) || !rows.length) continue;
      const primaryKey = table === 'settings' ? 'key' : 'id';

      const BATCH_SIZE = 400;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const chunk = rows.slice(i, i + BATCH_SIZE);
        const batch = this.db.batch();
        for (const row of chunk) {
          if (!row || typeof row !== 'object') continue;
          
          const docId = String(row[primaryKey] || this.generateId(table));
          let docRef;

          // Special case for subcollections
          if (table === 'story_episodes' && row.universe_id) {
            docRef = this.db.collection('story_universes').doc(row.universe_id).collection('episodes').doc(docId);
          } else if (table === 'production_scenes' && row.production_id) {
            docRef = this.db.collection('productions').doc(row.production_id).collection('scenes').doc(docId);
          } else if (table === 'production_scene_revisions' && row.production_id && row.scene_id) {
            docRef = this.db.collection('productions').doc(row.production_id).collection('scenes').doc(row.scene_id).collection('scene_revisions').doc(docId);
          } else {
            docRef = this.db.collection(table).doc(docId);
          }

          batch.set(docRef, { ...row, imported_at: new Date().toISOString() }, { merge: true });
        }
        await batch.commit();
      }
    }
    return true;
  }
}

module.exports = { FirestoreDatabase };
