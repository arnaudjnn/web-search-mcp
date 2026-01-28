import * as fs from 'fs/promises';
import * as readline from 'readline';

import langfuse from './ai/observability.js';
import { deepResearch, writeFinalReport } from './deep-research.js';
import { getModel } from './ai/providers.js';
import { generateFeedback } from './feedback.js';
import { OutputManager } from './output-manager.js';

const output = new OutputManager();

// Helper function for consistent logging
function log(...args: any[]) {
  output.log(...args);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper function to get user input
function askQuestion(query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, answer => {
      resolve(answer);
    });
  });
}

// run the agent
async function run() {
  // Create main research session trace
  const sessionTrace = langfuse.trace({
    name: 'Research Session',
  });

  // Track initial setup and query refinement
  const setupSpan = sessionTrace.span({ name: 'Initial Setup' });
  const initialQuery = await askQuestion('What would you like to research? ');
  const breadth =
    parseInt(
      await askQuestion(
        'Enter research breadth (recommended 2-10, default 4): ',
      ),
      10,
    ) || 4;
  const depth =
    parseInt(
      await askQuestion('Enter research depth (recommended 1-5, default 2): '),
      10,
    ) || 2;

  const providerInput = (await askQuestion('Model provider (openai|anthropic|google|xai) [openai]: ')).trim();
  const allowedProviders = ['openai', 'anthropic', 'google', 'xai'];
  const chosenProvider = allowedProviders.includes(providerInput) ? providerInput : 'openai';
  if (providerInput && chosenProvider === 'openai' && providerInput !== 'openai') {
    log(`Unknown provider "${providerInput}", defaulting to openai.`);
  }
  const chosenModelName = (await askQuestion('Model name (enter for default): ')).trim();
  const modelSpecifier = chosenModelName ? `${chosenProvider}:${chosenModelName}` : `${chosenProvider}:`;
  const model = getModel(modelSpecifier);
  const tokenBudgetInput = (await askQuestion('Optional research token budget (total tokens, press Enter to skip): ')).trim();
  const tokenBudget = tokenBudgetInput ? parseInt(tokenBudgetInput, 10) || undefined : undefined;
  const sourcePreferences = (await askQuestion('Optional source preferences to avoid (e.g., "avoid SEO top 10 listicles, forums, affiliate reviews"). Press Enter to skip: ')).trim();
  setupSpan.end({
    output: {
      initialQuery,
      breadth,
      depth,
      tokenBudget: tokenBudget ?? null,
    },
  });

  // Generate and collect feedback questions
  log(`Creating research plan...`);
  const feedbackSpan = sessionTrace.span({
    name: 'Generate Feedback Questions',
  });

  const followUpQuestions = await generateFeedback({ query: initialQuery, model });

  log(
    '\nTo better understand your research needs, please answer these follow-up questions:',
  );
  const answers: string[] = [];
  for (const question of followUpQuestions) {
    const answer = await askQuestion(`\n${question}\nYour answer: `);
    answers.push(answer);
  }

  feedbackSpan.end({
    output: {
      questions: followUpQuestions,
      answers,
      questionCount: followUpQuestions.length,
    },
  });

  // Combine queries and start research
  const combinedQuery = `
Initial Query: ${initialQuery}
Follow-up Questions and Answers:
${followUpQuestions.map((q: string, i: number) => `Q: ${q}\nA: ${answers[i]}`).join('\n')}
`;

  log('\nResearching your topic...');
  log('\nStarting research with progress tracking...\n');

  // Track the deep research process
  const researchSpan = sessionTrace.span({
    name: 'Deep Research',
    input: {
      query: combinedQuery,
      breadth,
      depth,
    },
  });

  // Track research metrics
  const researchMetrics = {
    queries: new Map(),
    sourceReliability: {
      high: 0,
      medium: 0,
      low: 0
    },
    totalLearnings: 0
  };

  const { learnings, visitedUrls, sourceMetadata, weightedLearnings, budget } = await deepResearch({
    query: combinedQuery,
    breadth,
    depth,
    model,
    tokenBudget,
    sourcePreferences: sourcePreferences || undefined,
    onProgress: progress => {
      output.updateProgress(progress);

      if (progress.currentQuery && progress.learningsCount) {
        // Track query chain in research span
        researchSpan.update({
          output: {
            queries: {
              current: progress.currentQuery,
              parent: progress.parentQuery,
              depth: progress.currentDepth,
              learnings: progress.learnings,
              followUps: progress.followUpQuestions
            }
          }
        });

        // Track metrics
        researchMetrics.queries.set(progress.currentQuery, {
          query: progress.currentQuery,
          parentQuery: progress.parentQuery,
          depth: progress.currentDepth,
          learnings: progress.learnings || [],
          followUpQuestions: progress.followUpQuestions || []
        });
        researchMetrics.totalLearnings += progress.learningsCount;
      }
    },
  });

  // Analyze source reliability distribution
  sourceMetadata.forEach(source => {
    if (source.reliabilityScore >= 0.8) researchMetrics.sourceReliability.high++;
    else if (source.reliabilityScore >= 0.5) researchMetrics.sourceReliability.medium++;
    else researchMetrics.sourceReliability.low++;
  });

  // Calculate weighted reliability score
  const avgReliability = weightedLearnings.length > 0
    ? weightedLearnings.reduce((acc, curr) => acc + curr.reliability, 0) / weightedLearnings.length
    : 0;

  researchSpan.end({
    output: {
      summary: {
        totalQueries: researchMetrics.queries.size,
        totalLearnings: learnings.length,
        uniqueSources: visitedUrls.length,
        avgReliability,
        sourceReliability: researchMetrics.sourceReliability
      },
      queries: Array.from(researchMetrics.queries.values())
    }
  });

  console.log(`\n\nLearnings:\n\n${learnings.join('\n')}`);
  console.log(`\n\nVisited URLs (${visitedUrls.length}):\n\n${visitedUrls.join('\n')}`);
  if (budget?.tokenBudget && budget.reached) {
    console.log(`Token budget reached (${budget.usedTokens}/${budget.tokenBudget}). Generating final report...`);
  } else {
    console.log('Writing final report...');
  }

  // Track report generation
  const reportSpan = sessionTrace.span({
    name: 'Generate Final Report',
    input: {
      learningCount: learnings.length,
      sourceCount: visitedUrls.length
    }
  });

  const report = await writeFinalReport({
    prompt: combinedQuery,
    learnings,
    visitedUrls,
    sourceMetadata,
    model
  });

  await fs.writeFile('output.md', report, 'utf-8');

  reportSpan.end({
    output: {
      reportLength: report.length,
      reportSaved: true
    }
  });

  console.log('Report written to output.md');

  // Update final session metrics
  sessionTrace.update({
    output: {
      summary: {
        totalLearnings: learnings.length,
        totalSources: visitedUrls.length,
        avgReliability,
        sourceReliability: researchMetrics.sourceReliability,
        reportLength: report.length
      }
    }
  });

  await langfuse.shutdownAsync();
  output.finish?.();
  rl.close();
}

// Let Langfuse handle error reporting automatically
run().catch(error => {
  log('Error:', error);
  rl.close();
});