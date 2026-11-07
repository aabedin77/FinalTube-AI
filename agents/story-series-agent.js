const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');

/**
 * StorySeriesIntelligenceAgent
 * Maintains multi-episode What-If story universes, character consistency, locations,
 * timeline continuity, and audience-demand-driven next episode planning.
 */
class StorySeriesIntelligenceAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('StorySeriesAgent');
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  async initialize() {
    this.logger.info('Initializing Story Series Intelligence Agent...');
    return true;
  }

  /**
   * Plans the next episode or creates a new narrative universe if audience demand is high
   */
  async planNextEpisode(universeId = null, feedbackInsights = []) {
    this.logger.info(`Planning narrative episode (Universe: ${universeId || 'auto-select'})...`);

    let universe = null;
    if (universeId) {
      universe = await this.db.getStoryUniverse(universeId);
    } else {
      const universes = await this.db.listStoryUniverses('active');
      if (universes.length > 0) {
        universe = universes[0]; // highest audience demand
      }
    }

    // If no universe exists yet, bootstrap the premier ImagineX flagship series
    if (!universe) {
      universe = await this.db.saveStoryUniverse({
        title: 'Zombie Apocalypse in the City: Hindi Chronicles (शहर में ज़ोंबी कयामत)',
        premise: 'A catastrophic synthetic contagion sweeps through a mega-city in India. Dr. Rohan and a band of survivors navigate underground secrets, survival dilemmas, and scientific breakthroughs.',
        genre: 'what_if_survival',
        characters: [
          { name: 'Dr. Rohan (डॉ. रोहन)', role: 'Lead Microbiologist & Protagonist', traits: 'Analytical, observant, calm under immense pressure' },
          { name: 'Aarav (आरव)', role: 'Former Tactical Officer', traits: 'Defensive specialist, decisive, protective' },
          { name: 'Ananya (अनन्या)', role: 'Communications Engineer', traits: 'Resourceful, radio frequency hacker, optimistic' }
        ],
        locations: [
          { name: 'Central Science Research Annex', description: 'Underground fortified laboratory with backup generators' },
          { name: 'Metro Line 3 Underground Tunnel', description: 'Dark, flooded transit tubes connecting safe sectors' },
          { name: 'Skyline Broadcast Tower', description: 'High-elevation radio relay point above the contaminated ground mist' }
        ],
        rules: [
          'Infection transmits through direct fluids and aerosol exposure in enclosed damp areas.',
          'Infected exhibit heightened auditory sensitivity in darkness but slow motor function under UV sunlight.',
          'No supernatural magic — every reaction has a grounded scientific biological mechanism.'
        ],
        episodeCount: 0,
        timelineEvents: [
          'Day 0: Patient zero identified in outer district water filtration plant.',
          'Day 2: City quarantine declared; communication towers compromised.'
        ],
        audienceDemandScore: 85
      });
    }

    const currentEpisodes = await this.db.listStoryEpisodes(universe.id);
    const nextEpisodeNumber = currentEpisodes.length + 1;

    let episodeData;
    if (this.aiTextService.isAvailable()) {
      episodeData = await this.generateEpisodeWithAI(universe, nextEpisodeNumber, feedbackInsights);
    } else {
      episodeData = this.generateEpisodeTemplate(universe, nextEpisodeNumber);
    }

    const savedEpisode = await this.db.saveStoryEpisode({
      universeId: universe.id,
      episodeNumber: nextEpisodeNumber,
      title: episodeData.title,
      summary: episodeData.summary,
      keyEvents: episodeData.keyEvents,
      cliffhanger: episodeData.cliffhanger,
      characterArcs: episodeData.characterArcs,
      status: 'planned'
    });

    // Update universe episode count and timeline
    universe.episodeCount = nextEpisodeNumber;
    universe.timelineEvents.push(`Episode ${nextEpisodeNumber}: ${episodeData.summary.substring(0, 120)}...`);
    await this.db.saveStoryUniverse(universe);

    this.logger.success(`Planned Episode ${nextEpisodeNumber} for Universe "${universe.title}": ${episodeData.title}`);
    return { universe, episode: savedEpisode };
  }

  async generateEpisodeWithAI(universe, episodeNumber, feedbackInsights = []) {
    const feedbackSummary = feedbackInsights.length 
      ? feedbackInsights.map(f => `- ${f.topic || f.summary || f}`).join('\n')
      : 'Audience wants high stakes, deep scientific explanations, and character survival decisions.';

    const prompt = `You are the lead narrative director for YouTube channel ImagineX.
Continue this ongoing story universe for Episode ${episodeNumber}:
Universe: "${universe.title}"
Premise: ${universe.premise}
Core Characters: ${JSON.stringify(universe.characters)}
Key Locations: ${JSON.stringify(universe.locations)}
Universe Rules: ${JSON.stringify(universe.rules)}
Previous Timeline: ${JSON.stringify(universe.timelineEvents)}
Audience Requests & Feedback:
${feedbackSummary}

REQUIREMENTS:
1. Maintain strict story continuity — DO NOT contradict established rules, dead characters, or past events.
2. Provide a bilingual title (Hindi Devanagari + English subtitle).
3. Dramatic What-If stakes suitable for an 8-12 minute video.
4. Powerful climax and hook/cliffhanger for the following episode.

Return ONLY a JSON object:
{
  "title": "Episode ${episodeNumber}: [Hindi Title in Devanagari] ([English Title])",
  "summary": "Detailed narrative summary of the episode",
  "keyEvents": ["Event 1", "Event 2", "Event 3", "Event 4"],
  "cliffhanger": "High-suspense ending hook for the next episode",
  "characterArcs": {
    "Dr. Rohan": "Specific struggle or choice in this episode"
  }
}`;

    try {
      const response = await this.aiTextService.generateText(prompt, {
        temperature: 0.7,
        maxTokens: 2048,
        systemInstruction: 'You are an expert cinematic storyteller and script supervisor who enforces strict world-building continuity.'
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      this.logger.warn(`AI Episode generation failed: ${err.message}. Using continuity template.`);
    }

    return this.generateEpisodeTemplate(universe, episodeNumber);
  }

  generateEpisodeTemplate(universe, episodeNumber) {
    const episodeTitles = [
      'The Outbreak In Darkness (अंधेरे में शुरुआत)',
      'The Underground Sector Breach (भूमिगत प्रयोगशाला का रहस्य)',
      'The Radio Tower Transmission (रेडियो सिग्नल की तलाश)',
      'The Antidote Synthesis Dilemma (एंटीडोट का खतरनाक परीक्षण)'
    ];
    const index = (episodeNumber - 1) % episodeTitles.length;
    return {
      title: `Episode ${episodeNumber}: ${episodeTitles[index]}`,
      summary: `Dr. Rohan and the surviving team face critical resource shortages and a mutated strain. They must secure the underground sector before nightfall.`,
      keyEvents: [
        'Discovery of an anomalous frequency broadcast from the northern sector.',
        'Breach at the lower airlock requiring immediate manual quarantine.',
        'Rohan isolates a synthesized compound that temporarily repels the contagion.'
      ],
      cliffhanger: 'The signal responds — but the voice is not human.',
      characterArcs: {
        'Dr. Rohan': 'Must balance scientific caution with urgent survival instincts.'
      }
    };
  }

  /**
   * Evaluates comment sentiment & requests to boost universe demand
   */
  async updateDemandFromComments(commentThemes = []) {
    const universes = await this.db.listStoryUniverses('active');
    for (const universe of universes) {
      let demandBoost = 0;
      const titleLower = universe.title.toLowerCase();
      for (const theme of commentThemes) {
        const text = String(theme.text || theme.theme || theme.topic || '').toLowerCase();
        if (text.includes('part 2') || text.includes('next episode') || text.includes('अगला भाग') || text.includes('सीरीज') || text.includes('zombie') || text.includes(titleLower.substring(0, 10))) {
          demandBoost += 10;
        }
      }
      if (demandBoost > 0) {
        universe.audienceDemandScore = Math.min(100, (universe.audienceDemandScore || 0) + demandBoost);
        await this.db.saveStoryUniverse(universe);
        this.logger.info(`Universe "${universe.title}" demand boosted to ${universe.audienceDemandScore}`);
      }
    }
  }
}

module.exports = { StorySeriesIntelligenceAgent };
