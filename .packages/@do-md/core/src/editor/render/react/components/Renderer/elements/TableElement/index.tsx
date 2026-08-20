import { ParentRenderData, RenderData } from "../../../../../../type";
import styles from '../../../../../../style/DOMD.module.css';
import { memo } from "react";
import BaseElement from "../../base/BaseElement";

interface Props {
  parsedData: ParentRenderData | RenderData;
}

function TableElement({
  parsedData,
}: Props) {
  return (
    <div className={styles.TableScrollable}>
      <BaseElement parsedData={parsedData} />
    </div>
  );
}

export default memo(TableElement);

