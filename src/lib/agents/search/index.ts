import { ResearcherOutput, SearchAgentInput } from './types';
import { formatSchemaParseError } from '@/lib/utils/normalizeStructuredOutput';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { Block, TextBlock } from '@/lib/types';
import { getTokenCount } from '@/lib/utils/splitText';

const persistMessageState = async (
  input: SearchAgentInput,
  session: SessionManager,
  patch?: { status: 'completed'; responseBlocks: Block[] },
) => {
  try {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!patch) {
      if (!exists) {
        await db.insert(messages).values({
          chatId: input.chatId,
          messageId: input.messageId,
          backendId: session.id,
          query: input.followUp,
          createdAt: new Date().toISOString(),
          status: 'answering',
          responseBlocks: [],
        });
      } else {
        await db
          .delete(messages)
          .where(
            and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
          )
          .execute();
        await db
          .update(messages)
          .set({
            status: 'answering',
            backendId: session.id,
            responseBlocks: [],
          })
          .where(
            and(
              eq(messages.chatId, input.chatId),
              eq(messages.messageId, input.messageId),
            ),
          )
          .execute();
      }
      return;
    }

    await db
      .update(messages)
      .set(patch)
      .where(
        and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
        ),
      )
      .execute();
  } catch (err) {
    console.error('Message persistence skipped (database unavailable):', err);
  }
};

const SEARCH_TIMEOUT_MS: Record<
  SearchAgentInput['config']['mode'],
  number
> = {
  speed: 90_000,
  balanced: 180_000,
  quality: 300_000,
};

class SearchAgent {
  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    const timeoutMs = SEARCH_TIMEOUT_MS[input.config.mode];

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Search timed out after ${Math.round(timeoutMs / 1000)}s. Try speed mode or a simpler query.`,
          ),
        );
      }, timeoutMs);
    });

    try {
      await Promise.race([
        this.runSearch(session, input),
        timeoutPromise,
      ]);
    } catch (err: unknown) {
      console.error('Search agent failed:', err);
      session.emit('error', {
        data:
          formatSchemaParseError(err) ||
          'Search failed. Check server logs, model API keys, and SearxNG.',
      });
      session.emit('end', {});
    }
  }

  private async runSearch(session: SessionManager, input: SearchAgentInput) {
    try {
      await persistMessageState(input, session);

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.llm,
    });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).then((widgetOutputs) => {
      widgetOutputs.forEach((o) => {
        session.emitBlock({
          id: crypto.randomUUID(),
          type: 'widget',
          data: {
            widgetType: o.type,
            params: o.data,
          },
        });
      });
      return widgetOutputs;
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    if (!classification.classification.skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(session, {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
      });
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    session.emit('data', {
      type: 'researchComplete',
    });

    let finalContext =
      '<Query to be answered without searching; Search not made>';

    if (searchResults) {
      finalContext = searchResults?.searchFindings
        .map(
          (f, index) =>
            `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
        )
        .join('\n');
    }

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    const writerPrompt = getWriterPrompt(
      finalContextWithWidgets,
      input.config.systemInstructions,
      input.config.mode,
    );

    const answerStream = input.config.llm.streamText({
      messages: [
        {
          role: 'system',
          content: writerPrompt,
        },
        ...input.chatHistory,
        {
          role: 'user',
          content: input.followUp,
        },
      ],
    });

    let responseBlockId = '';

    for await (const chunk of answerStream) {
      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);

        responseBlockId = block.id;
      } else {
        const block = session.getBlock(responseBlockId) as TextBlock | null;

        if (!block) {
          continue;
        }

        block.data += chunk.contentChunk;

        session.updateBlock(block.id, [
          {
            op: 'replace',
            path: '/data',
            value: block.data,
          },
        ]);
      }
    }

    session.emit('end', {});

    await persistMessageState(input, session, {
      status: 'completed',
      responseBlocks: session.getAllBlocks(),
    });
    } catch (err: any) {
      throw err;
    }
  }
}

export default SearchAgent;
