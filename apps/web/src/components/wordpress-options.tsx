import { Loader, MultiSelect, Stack, TagsInput, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { orpc } from '../lib/orpc';
import type { Account } from '../lib/platforms';

export interface WordPressOptionsValue {
  tags: string[];
  /** Category ids per WordPress account. */
  categories: Record<string, number[]>;
}

type Category = { id: number; name: string; parent: number };

/** "Parent › Child" labels, sorted so children follow their parents. */
function categoryOptions(categories: Category[]) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const path = (c: Category, seen = new Set<number>()): string => {
    const parent = byId.get(c.parent);
    if (!parent || seen.has(parent.id)) return c.name;
    seen.add(c.id);
    return `${path(parent, seen)} › ${c.name}`;
  };
  return categories
    .map((c) => ({ value: String(c.id), label: path(c) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function CategoryPicker(props: {
  account: Account;
  showSiteName: boolean;
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const categories = useQuery(
    orpc.accounts.wordpressCategories.queryOptions({
      input: { accountId: props.account.id },
      staleTime: 5 * 60_000,
    }),
  );
  const label = props.showSiteName ? `Categories on ${props.account.displayName}` : 'Categories';

  return (
    <MultiSelect
      label={label}
      placeholder={props.value.length ? undefined : 'Default category'}
      data={categoryOptions(categories.data ?? [])}
      value={props.value.map(String)}
      onChange={(ids) => props.onChange(ids.map(Number))}
      searchable
      clearable
      nothingFoundMessage="No matching category"
      rightSection={categories.isLoading ? <Loader size="xs" /> : undefined}
      error={categories.error ? `Could not load categories: ${categories.error.message}` : null}
    />
  );
}

/** Categories (per site) and tags (shared) for WordPress posts. */
export function WordPressOptions(props: {
  accounts: Account[];
  value: WordPressOptionsValue;
  onChange: (value: WordPressOptionsValue) => void;
}) {
  const { value } = props;
  return (
    <Stack gap="sm">
      {props.accounts.map((account) => (
        <CategoryPicker
          key={account.id}
          account={account}
          showSiteName={props.accounts.length > 1}
          value={value.categories[account.id] ?? []}
          onChange={(ids) =>
            props.onChange({ ...value, categories: { ...value.categories, [account.id]: ids } })
          }
        />
      ))}
      <TagsInput
        label="Tags"
        placeholder={value.tags.length ? undefined : 'Type a tag and press Enter'}
        value={value.tags}
        onChange={(tags) => props.onChange({ ...value, tags })}
        maxTags={50}
        clearable
        splitChars={[',']}
      />
      <Text size="xs" c="dimmed">
        Tags the site doesn’t have yet are created when the post is published.
      </Text>
    </Stack>
  );
}
