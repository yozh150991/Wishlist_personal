-- Пошук по всіх списках власника (ROADMAP 8.11).
--
-- Одна функція власника: шукає в назві, нотатці, магазині (хост посилання без
-- www. і source_site) та ознаках (variants: label і value) — у всіх списках,
-- разом з архівом. Кожне слово запиту мусить знайтися хоч в одному полі;
-- поля склеєно переносом рядка, тож слово (без пробілів) не зшиває два поля.
--
-- Регістр і діакритика не важать: обидва боки проходять lower() і
-- translate() з однією таблицею літер — польські ą/ł/ż…, ї/є/ґ/й, апострофи
-- ’ ‘ ʼ `. Розширення unaccent не потрібне: таблиця мала, імутабельна й
-- рівно та сама, що в app/src/lib/search.ts (FOLD_FROM / FOLD_TO) — тест
-- search.spec.ts звіряє рядки в цьому файлі з тими константами.
--
-- Приватність (CLAUDE.md §3.1): SECURITY INVOKER — RLS items_select_own і
-- lists_select_own відсіюють чуже, а явна умова owner_id = auth.uid() лише
-- дає планувальнику індекс items_owner_idx. Нового індексу немає: позицій
-- одного власника — сотні, а пошук «%слово%» по trigram-індексу на згорнутому
-- виразі коштував би запису на кожну правку без помітного виграшу.
--
-- Позначок гостей функція не чіпає й не знає (§3.2): лише items і lists.

create or replace function public.search_my_items(p_query text, p_limit integer default 50)
returns setof public.items
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_words text[];
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'bad_limit' using errcode = '22023';
  end if;
  -- Та сама межа, що maxLength у полі пошуку (SEARCH_QUERY_MAX).
  if char_length(coalesce(p_query, '')) > 100 then
    raise exception 'bad_query' using errcode = '22023';
  end if;

  select coalesce(array_agg(w), '{}')
    into v_words
    from (select w
            from regexp_split_to_table(
                   translate(lower(coalesce(p_query, '')),
                             $f$ąáàâäãåāćčçęéèêëěēíìîïīłľĺńňñóòôöõőøōřŕśšťďúùûüůűūýÿźżžїєґйёў’‘ʼ`$f$,
                             $t$aaaaaaaaccceeeeeeeiiiiilllnnnoooooooorrsstduuuuuuuyyzzzіегиеу''''$t$),
                   '\s+') as w
           where w <> ''
           limit 8) s;

  if cardinality(v_words) = 0 then
    return;
  end if;

  return query
  select i.*
    from public.items i
    join public.lists l on l.id = i.list_id
   cross join lateral (
     select translate(lower(i.title),
                      $f$ąáàâäãåāćčçęéèêëěēíìîïīłľĺńňñóòôöõőøōřŕśšťďúùûüůűūýÿźżžїєґйёў’‘ʼ`$f$,
                      $t$aaaaaaaaccceeeeeeeiiiiilllnnnoooooooorrsstduuuuuuuyyzzzіегиеу''''$t$) as title,
            translate(lower(concat_ws(E'\n',
                              i.title,
                              i.note,
                              regexp_replace(
                                substring(i.url from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/:?#]+)'),
                                '^www\.', '', 'i'),
                              i.source_site,
                              (select string_agg((v->>'label') || ' ' || (v->>'value'), E'\n')
                                 from jsonb_array_elements(i.variants) v))),
                      $f$ąáàâäãåāćčçęéèêëěēíìîïīłľĺńňñóòôöõőøōřŕśšťďúùûüůűūýÿźżžїєґйёў’‘ʼ`$f$,
                      $t$aaaaaaaaccceeeeeeeiiiiilllnnnoooooooorrsstduuuuuuuyyzzzіегиеу''''$t$) as hay
   ) h
   where i.owner_id = (select auth.uid())
     and not exists (select 1 from unnest(v_words) w where strpos(h.hay, w) = 0)
   -- Спершу ті, де все знайшлося в назві; далі живі списки перед архівом;
   -- далі свіжіше змінені. Той самий порядок — у rankHits (lib/search.ts).
   order by (not exists (select 1 from unnest(v_words) w where strpos(h.title, w) = 0)) desc,
            l.is_archived,
            i.updated_at desc,
            i.id
   limit p_limit;
end
$$;

comment on function public.search_my_items(text, integer) is
  'Пошук власника по всіх своїх списках, з архівом (ROADMAP 8.11): назва, нотатка, магазин, ознаки; без регістру й діакритики. SECURITY INVOKER — чуже відсіює RLS.';

-- Функція власника (CLAUDE.md §3.4): Supabase видає EXECUTE ролям окремо.
revoke execute on function public.search_my_items(text, integer) from public, anon;
grant  execute on function public.search_my_items(text, integer) to authenticated;
