import React from 'react';
import styled from 'styled-components';
import PropTypes from 'prop-types';
import classNames from 'classnames';
import List, { ListItem, ListItemIcon, ListItemText } from 'material-ui/List';
import Typography from 'material-ui/Typography';
import DraftsIcon from 'material-ui-icons/Drafts';
import StarIcon from 'material-ui-icons/Star';
import { withStyles } from 'material-ui/styles/index';
import { AUTHOR_MAIL, AUTHOR_GITHUB } from '../constants/contact-info';



const Container = styled(List)`
  && {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-direction: row;
    flex: 0;
    padding: 0;
    overflow: hidden;
    min-height: 60px;
    height: 60px;
  }
`;

const ListContainer = styled(List)`
  && {
    display: flex;
    align-items: flex-end;
    flex-direction: row;
    padding: 0;
    overflow: hidden;
    flex-grow: 0;
    height: 60px;
    padding-bottom: 15px;
  }
`;

const ListItemContainer = styled(ListItem)`
  && {
    margin: 0px;
    padding: 0 10px 0 10px;
  }
`;

const styles = {
  whiteText: {
    color: 'rgba(255, 255, 255, 0.68)',
  },
};

class Footer extends React.PureComponent {
  render() {
    const { classes } = this.props;
    return (
      <Container>
        <ListContainer>
          <ListItemContainer
            button
            onClick={() => window.open(AUTHOR_GITHUB, '_blank')}
          >
            <ListItemText
              disableTypography
            >
              <Typography className={classNames(classes.whiteText)}>© 2018, Gennaro Anesi</Typography>
            </ListItemText>
          </ListItemContainer>
        </ListContainer>
        <ListContainer>
          <ListItemContainer
            button
            onClick={() =>
              window.open(
                `mailto:${AUTHOR_MAIL}?subject=Question&body=Hi, Gennaro!`,
              )
            }
          >
            <ListItemIcon>
              <DraftsIcon className={classNames(classes.whiteText)} />
            </ListItemIcon>
          </ListItemContainer>
          <ListItemContainer
            button
            onClick={() =>
              window.open(`${AUTHOR_GITHUB}/gennaroanesi.com`, '_blank')
            }
          >
            <ListItemIcon>
              <StarIcon className={classNames(classes.whiteText)} />
            </ListItemIcon>
          </ListItemContainer>
        </ListContainer>
      </Container>
    );
  }
}

Footer.propTypes = {
  classes: PropTypes.object.isRequired,
};

export default withStyles(styles)(Footer);
