import { useEffect } from 'react';

// 打开时把焦点移入弹窗，关闭时归还给触发元素
export const useModalFocus = (initialFocusRef) => {
    useEffect(() => {
        // 必须在移动焦点之前记录，否则记到的是弹窗内的元素
        const trigger = document.activeElement;

        initialFocusRef.current?.focus();

        return () => {
            if (trigger instanceof HTMLElement && trigger.isConnected) {
                trigger.focus();
            }
        };
    }, [initialFocusRef]);
};
