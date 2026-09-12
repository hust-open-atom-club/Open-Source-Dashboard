'use strict';

const cron = require('node-cron');

/**
 * 数据采集定时任务的默认计划：每 6 小时执行一次。
 * 未配置环境变量时使用该值，与历史行为保持一致。
 */
const DEFAULT_INGESTION_CRON_SCHEDULE = '0 */6 * * *';

/** 覆盖数据采集计划的环境变量名。 */
const INGESTION_CRON_SCHEDULE_ENV_VAR = 'INGESTION_CRON_SCHEDULE';

/**
 * 配置的采集计划不是合法 cron 表达式时抛出的错误。
 * message 中会带上环境变量名与实际取值，便于启动日志定位问题。
 */
class InvalidIngestionCronScheduleError extends Error {
    constructor(configuredValue) {
        super(
            `${INGESTION_CRON_SCHEDULE_ENV_VAR}="${configuredValue}" is not a valid cron expression. ` +
            `Fix it or remove the variable to fall back to the default "${DEFAULT_INGESTION_CRON_SCHEDULE}".`,
        );
        this.name = 'InvalidIngestionCronScheduleError';
        this.envVar = INGESTION_CRON_SCHEDULE_ENV_VAR;
        this.configuredValue = configuredValue;
    }
}

/**
 * 解析数据采集的 cron 表达式。
 *
 * 未设置或只包含空白字符时回退到默认值；已设置时用 node-cron 的校验能力检查，
 * 非法表达式抛出 InvalidIngestionCronScheduleError，由调用方决定如何处理。
 *
 * @param {string|undefined|null} rawValue 环境变量原始值。
 * @returns {string} 可直接交给 cron.schedule 使用的表达式。
 */
const resolveIngestionCronSchedule = (rawValue) => {
    const configuredValue = typeof rawValue === 'string' ? rawValue.trim() : '';

    if (!configuredValue) {
        return DEFAULT_INGESTION_CRON_SCHEDULE;
    }

    if (!cron.validate(configuredValue)) {
        throw new InvalidIngestionCronScheduleError(configuredValue);
    }

    return configuredValue;
};

module.exports = {
    DEFAULT_INGESTION_CRON_SCHEDULE,
    INGESTION_CRON_SCHEDULE_ENV_VAR,
    InvalidIngestionCronScheduleError,
    resolveIngestionCronSchedule,
};
