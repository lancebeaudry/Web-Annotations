-- v28: a "Feature request" label (key: feature) alongside bug, copy, design,
-- content, photo and decision.
alter table comments drop constraint if exists comments_labels_check;
alter table comments add constraint comments_labels_check
  check (labels <@ array['bug','copy','design','content','photo','decision','feature']::text[]);
