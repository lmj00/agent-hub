ALTER TABLE `runs` ADD `stop_reason` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `stop_requested_at` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `termination_confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `cancel_requested_at` integer;--> statement-breakpoint
-- 기존 기록은 사용자 취소와 서버 종료를 구분할 수 없습니다. 시각·종료 확인은 추정하지 않습니다.
UPDATE `runs` SET `stop_reason` = 'unknown' WHERE `error_code` = 'cancel_requested';--> statement-breakpoint
UPDATE `runs` SET `stop_reason` = 'timeout' WHERE `error_code` = 'timeout';
