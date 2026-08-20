import { useContext } from 'react';
import { EditorDomContext } from '../context';

export const useEditorDom = () => {
    const context = useContext(EditorDomContext);
    if (!context) {
        throw new Error('useEditorDom must be used within EditorDomContext');
    }
    return context;
};