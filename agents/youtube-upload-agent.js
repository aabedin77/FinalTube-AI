const { google } = require('googleapis');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { Logger } = require('../utils/logger');
const { assertValidYouTubeMetadata } = require('../utils/youtube-metadata-validator');

class YouTubeUploadAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('YouTubeUpload');
    this.youtube = null;
  }

  async initialize() {
    this.logger.info('Initializing YouTube Upload Agent...');
    try {
      if (this.credentials?.hasPublishingCapability?.()) {
        const auth = this.credentials.getYouTubeAuth();
        this.youtube = google.youtube({ version: 'v3', auth });
        this.logger.success('YouTube API initialized for uploads');
      } else {
        this.logger.warn('YouTube OAuth not connected. Upload agent will remain idle.');
      }
    } catch (error) {
      this.logger.error('Failed to initialize YouTube API:', error);
    }
    return true;
  }

  /**
   * Main entry point for uploading a video
   */
  async uploadVideo(productionId, options = {}) {
    this.logger.info(`Starting upload process for production: ${productionId}`);
    
    try {
      // Use provided auth if available (for client-side token flow)
      const auth = options.auth || (this.credentials?.hasPublishingCapability?.() ? this.credentials.getYouTubeAuth() : null);
      if (!auth) throw new Error('YouTube API not authorized. Please connect your channel.');
      
      const youtube = google.youtube({ version: 'v3', auth });

      // 1. Get production bundle
      const bundle = await this.db.getProductionBundle(productionId);
      if (!bundle) throw new Error('Production bundle not found');

      // 2. Validate video file
      const videoPath = bundle.assets?.finalVideo?.path;
      if (!videoPath || bundle.assets?.finalVideo?.simulated) {
        throw new Error('No valid MP4 file found for production');
      }
      await fsPromises.access(videoPath);
      const stats = await fsPromises.stat(videoPath);
      if (stats.size === 0) throw new Error('Video file is empty');

      // 3. Validate metadata
      const { value: metadata } = assertValidYouTubeMetadata(bundle.seo || {});
      
      // 4. Determine privacy status (Safety First: Default to private)
      const autoPublic = await this.db.getSetting('auto_public_publishing') === 'true';
      const requestedPrivacy = options.privacyStatus || bundle.editorData?.privacyStatus || 'private';
      const finalPrivacy = autoPublic ? requestedPrivacy : 'private';

      this.logger.info(`Uploading as ${finalPrivacy}. (Auto-public: ${autoPublic})`);

      // 5. Check for duplicate upload
      const existing = await this.db.getLatestScheduleEntry(productionId);
      if (existing && existing.youtubeId && existing.status === 'published') {
        this.logger.warn(`Video already uploaded to YouTube: ${existing.youtubeId}`);
        return existing;
      }

      // 6. Execute resumable upload
      const videoId = await this.executeResumableUpload(youtube, videoPath, {
        snippet: {
          title: metadata.title,
          description: metadata.description,
          tags: metadata.tags,
          categoryId: metadata.categoryId,
          defaultLanguage: metadata.defaultLanguage,
          defaultAudioLanguage: metadata.defaultAudioLanguage
        },
        status: {
          privacyStatus: finalPrivacy,
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: bundle.provenance?.containsSyntheticMedia === true
        }
      });

      this.logger.success(`Upload successful: ${videoId}`);

      // 7. Upload thumbnail
      if (bundle.assets?.thumbnail?.path) {
        await this.uploadThumbnail(youtube, videoId, bundle.assets.thumbnail.path);
      }

      // 8. Update database
      const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const scheduleUpdate = {
        productionId,
        youtubeId: videoId,
        youtubeUrl,
        status: 'published',
        publishedAt: new Date().toISOString()
      };

      if (existing) {
        await this.db.updateScheduleEntry({ ...existing, ...scheduleUpdate });
      } else {
        await this.db.saveScheduleEntry({
          ...scheduleUpdate,
          title: metadata.title,
          publishTime: new Date().toISOString(),
          metadata: { seo: metadata, video: bundle.assets.finalVideo }
        });
      }

      await this.db.updateProductionStatus(productionId, 'published');
      
      return { videoId, youtubeUrl };
    } catch (error) {
      this.logger.error('Upload failed:', error);
      throw error;
    }
  }

  async executeResumableUpload(youtube, filePath, metadata) {
    const fileSize = fs.statSync(filePath).size;
    this.logger.info(`Starting resumable upload for ${path.basename(filePath)} (${fileSize} bytes)`);

    return new Promise((resolve, reject) => {
      youtube.videos.insert(
        {
          part: 'snippet,status',
          requestBody: metadata,
          media: {
            body: fs.createReadStream(filePath)
          }
        },
        {
          onUploadProgress: evt => {
            const progress = Math.round((evt.bytesRead / fileSize) * 100);
            this.logger.info(`Upload progress: ${progress}%`);
          }
        },
        (err, res) => {
          if (err) return reject(err);
          resolve(res.data.id);
        }
      );
    });
  }

  async uploadThumbnail(youtube, videoId, thumbnailPath) {
    try {
      this.logger.info(`Uploading thumbnail for ${videoId}: ${thumbnailPath}`);
      const thumbnailBuffer = await fsPromises.readFile(thumbnailPath);
      
      await youtube.thumbnails.set({
        videoId: videoId,
        media: {
          body: thumbnailBuffer
        }
      });
      this.logger.success('Thumbnail uploaded');
    } catch (error) {
      this.logger.error('Failed to upload thumbnail:', error);
    }
  }
}

module.exports = { YouTubeUploadAgent };
