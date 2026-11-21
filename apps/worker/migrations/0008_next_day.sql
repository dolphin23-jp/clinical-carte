-- 日をまたいだ記載（CA-047）：記載の中で、日をまたいだと本人が入れる欄で確かめた場所（保存した文の中の位置）。
-- ここより後ろの、日の書かれていない時刻（「0:15」）は、翌日として読む。確かめていない・またいでいない文は NULL
ALTER TABLE sources ADD COLUMN next_day_from INTEGER CHECK (next_day_from IS NULL OR next_day_from >= 0);
