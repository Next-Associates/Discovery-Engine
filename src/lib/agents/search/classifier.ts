import z from 'zod';
import { ClassifierInput, ClassifierOutput } from './types';
import { classifierPrompt } from '@/lib/prompts/search/classifier';
import formatChatHistoryAsString from '@/lib/utils/formatHistory';

const schema = z.object({
  classification: z.object({
    skipSearch: z
      .boolean()
      .describe('Indicates whether to skip the search step.'),
    personalSearch: z
      .boolean()
      .describe('Indicates whether to perform a personal search.'),
    academicSearch: z
      .boolean()
      .describe('Indicates whether to perform an academic search.'),
    discussionSearch: z
      .boolean()
      .describe('Indicates whether to perform a discussion search.'),
    showWeatherWidget: z
      .boolean()
      .describe('Indicates whether to show the weather widget.'),
    showStockWidget: z
      .boolean()
      .describe('Indicates whether to show the stock widget.'),
    showCalculationWidget: z
      .boolean()
      .describe('Indicates whether to show the calculation widget.'),
  }),
  standaloneFollowUp: z
    .string()
    .describe(
      "A self-contained, context-independent reformulation of the user's question.",
    ),
});

export function defaultClassification(query: string): ClassifierOutput {
  return {
    classification: {
      skipSearch: false,
      personalSearch: false,
      academicSearch: false,
      discussionSearch: false,
      showWeatherWidget: false,
      showStockWidget: false,
      showCalculationWidget: false,
    },
    standaloneFollowUp: query,
  };
}

export const classify = async (input: ClassifierInput) => {
  try {
    const output = await input.llm.generateObject<typeof schema>({
      messages: [
        {
          role: 'system',
          content: classifierPrompt,
        },
        {
          role: 'user',
          content: `<conversation_history>\n${formatChatHistoryAsString(input.chatHistory)}\n</conversation_history>\n<user_query>\n${input.query}\n</user_query>`,
        },
      ],
      schema,
    });

    return output;
  } catch (err) {
    console.error('Classifier failed, using safe defaults:', err);
    return defaultClassification(input.query);
  }
};
