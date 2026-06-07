import Select from '@/components/ui/Select';
import { ConfigModelProvider } from '@/lib/config/types';
import { useChat } from '@/lib/hooks/useChat';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

const dedupeOptions = <T extends { value: string }>(options: T[]): T[] => {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
};

const ModelSelect = ({
  providers,
  type,
}: {
  providers: ConfigModelProvider[];
  type: 'chat' | 'embedding';
}) => {
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(false);
  const { setChatModelProvider, setEmbeddingModelProvider } = useChat();

  const options = useMemo(
    () =>
      dedupeOptions(
        type === 'chat'
          ? providers.flatMap((provider) =>
              provider.chatModels.map((model) => ({
                value: `${provider.id}/${model.key}`,
                label: `${provider.name} - ${model.name}`,
              })),
            )
          : providers.flatMap((provider) =>
              provider.embeddingModels.map((model) => ({
                value: `${provider.id}/${model.key}`,
                label: `${provider.name} - ${model.name}`,
              })),
            ),
      ),
    [providers, type],
  );

  useEffect(() => {
    if (options.length === 0) return;

    const providerId =
      type === 'chat'
        ? localStorage.getItem('chatModelProviderId')
        : localStorage.getItem('embeddingModelProviderId');
    const modelKey =
      type === 'chat'
        ? localStorage.getItem('chatModelKey')
        : localStorage.getItem('embeddingModelKey');

    const storedValue =
      providerId && modelKey ? `${providerId}/${modelKey}` : null;
    const resolvedValue =
      storedValue && options.some((option) => option.value === storedValue)
        ? storedValue
        : options[0].value;

    setSelectedModel(resolvedValue);

    if (resolvedValue !== storedValue) {
      const providerIdFromValue = resolvedValue.split('/')[0];
      const modelKeyFromValue = resolvedValue.split('/').slice(1).join('/');

      if (type === 'chat') {
        localStorage.setItem('chatModelProviderId', providerIdFromValue);
        localStorage.setItem('chatModelKey', modelKeyFromValue);
      } else {
        localStorage.setItem('embeddingModelProviderId', providerIdFromValue);
        localStorage.setItem('embeddingModelKey', modelKeyFromValue);
      }
    }
  }, [options, type]);

  const handleSave = async (newValue: string) => {
    setLoading(true);
    setSelectedModel(newValue);

    try {
      if (type === 'chat') {
        const providerId = newValue.split('/')[0];
        const modelKey = newValue.split('/').slice(1).join('/');

        localStorage.setItem('chatModelProviderId', providerId);
        localStorage.setItem('chatModelKey', modelKey);

        setChatModelProvider({
          providerId: providerId,
          key: modelKey,
        });
      } else {
        const providerId = newValue.split('/')[0];
        const modelKey = newValue.split('/').slice(1).join('/');

        localStorage.setItem('embeddingModelProviderId', providerId);
        localStorage.setItem('embeddingModelKey', modelKey);

        setEmbeddingModelProvider({
          providerId: providerId,
          key: modelKey,
        });
      }
    } catch (error) {
      console.error('Error saving config:', error);
      toast.error('Failed to save configuration.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="rounded-xl border border-light-200 bg-light-primary/80 p-4 lg:p-6 transition-colors dark:border-dark-200 dark:bg-dark-primary/80">
      <div className="space-y-3 lg:space-y-5">
        <div>
          <h4 className="text-sm lg:text-sm text-black dark:text-white">
            Select {type === 'chat' ? 'Chat Model' : 'Embedding Model'}
          </h4>
          <p className="text-[11px] lg:text-xs text-black/50 dark:text-white/50">
            {type === 'chat'
              ? 'Choose which model to use for generating responses'
              : 'Choose which model to use for generating embeddings'}
          </p>
        </div>
        <Select
          value={selectedModel}
          onChange={(event) => handleSave(event.target.value)}
          options={options}
          className="!text-xs lg:!text-[13px]"
          loading={loading}
          disabled={loading}
        />
      </div>
    </section>
  );
};

export default ModelSelect;
