import { describe, expect, it } from 'vitest';
import { contract, appEvents } from '../src';

describe('contract', () => {
    it('所有 procedure 与事件的 channel 名唯一', () => {
        const channels = [
            ...Object.values(contract).flatMap((group) =>
                Object.values(group).map((proc) => proc.channel),
            ),
            ...Object.values(appEvents).map((evt) => evt.channel),
        ];
        expect(new Set(channels).size).toBe(channels.length);
    });

    it('settings schema 能填充默认值', () => {
        const parsed = contract.settings.getAll.output.parse({});
        expect(parsed).toEqual({
            theme: 'system',
            locale: 'en-US',
            launchCount: 0,
        });
    });

    it('openFilePicker 输入的 multiple 默认 false 且剥离未知字段', () => {
        const parsed = contract.system.openFilePicker.input.parse({
            title: 'hi',
            hackerField: true,
        });
        expect(parsed).toEqual({ title: 'hi', multiple: false });
    });
});
